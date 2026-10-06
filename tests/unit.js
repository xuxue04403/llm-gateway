// tests/unit.js — 单元回归（纯函数与文件读写，不启 Electron、不联网）
// 运行：node tests/unit.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { t, run } = require('./_harness');

const util = require('../src/writers/util');
const models = require('../src/writers/models');
const datadir = require('../src/datadir');
const probe = require('../src/probe');
const { validateConfigText } = require('../src/gateway-manager');
const modelMeta = require('../src/model-meta');
const { Settings } = require('../src/settings');
const logger = require('../src/logger');
const crashReport = require('../src/crash-report');
const winutil = require('../src/winutil');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-unit-'));

/* ==================== util：文件读写 ==================== */

t('util.writeAtomic：首次写入留下 .bak-llmgateway 备份', () => {
  const f = path.join(tmp, 'atomic1.json');
  fs.writeFileSync(f, 'old', 'utf8');
  const r = util.writeAtomic(f, 'new');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(f + util.BACKUP_SUFFIX, 'utf8'), 'old', '应保留最原始的那份');
});

t('util.writeAtomic：备份已存在时不覆盖（保住最原始的内容）', () => {
  const f = path.join(tmp, 'atomic2.json');
  fs.writeFileSync(f, 'v1', 'utf8');
  util.writeAtomic(f, 'v2');
  util.writeAtomic(f, 'v3');
  assert.strictEqual(fs.readFileSync(f + util.BACKUP_SUFFIX, 'utf8'), 'v1');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v3');
});

t('util.restore：恢复备份，并把当前内容另存为 before-restore', () => {
  const f = path.join(tmp, 'atomic3.json');
  fs.writeFileSync(f, '原始', 'utf8');
  util.writeAtomic(f, '改过');
  const r = util.restore(f);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '原始');
  assert.strictEqual(fs.readFileSync(f + '.bak-llmgateway-before-restore', 'utf8'), '改过');
});

t('util.writeAtomic：父目录不存在时自动创建（新机器上 ~/.codex 可能还没有）', () => {
  const f = path.join(tmp, 'deep', 'a', 'b', 'x.json');
  const r = util.writeAtomic(f, '{}');
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(f));
});

t('util.readJson：文件不存在返回 {}；坏 JSON 返回 __parseError 而不是抛', () => {
  assert.deepStrictEqual(util.readJson(path.join(tmp, 'nope.json')), {});
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{oops', 'utf8');
  const r = util.readJson(bad);
  assert.ok(r.__parseError, '应带 __parseError');
});

/* ==================== util：TOML 定点编辑 ==================== */

t('tomlUpsertTable：表不存在则追加；存在则整段替换（不动其它表）', () => {
  const before = [
    'model = "gpt-5-codex"',
    'model_provider = "anyrouter"',
    '',
    '[model_providers.anyrouter]',
    'name = "Any Router"',
    'base_url = "https://x/v1"',
    '',
    '[mcp_servers.context7]',
    'command = "npx.cmd"',
    '',
  ].join('\n');
  const after = util.tomlUpsertTable(before, 'model_providers.llmgateway', ['name = "LLM Gateway"', 'base_url = "http://127.0.0.1:3091/v1"']);
  assert.ok(after.includes('[model_providers.llmgateway]'), '应有新表');
  assert.ok(after.includes('[model_providers.anyrouter]'), 'anyrouter 表必须保留');
  assert.ok(after.includes('[mcp_servers.context7]'), 'mcp_servers 表必须保留');

  const again = util.tomlUpsertTable(after, 'model_providers.llmgateway', ['name = "LLM Gateway 2"']);
  assert.ok(again.includes('LLM Gateway 2'));
  assert.strictEqual((again.match(/\[model_providers\.llmgateway\]/g) || []).length, 1, '不得出现重复表头');
});

t('tomlUpsertTopKey：就地替换；不存在则插到第一个表头之前（TOML 要求顶层键在前）', () => {
  const before = 'model = "a"\nmodel_provider = "old"\n\n[section]\nk = "v"\n';
  const r = util.tomlUpsertTopKey(before, 'model_provider', '"new"');
  assert.ok(r.includes('model_provider = "new"'));
  assert.ok(!r.includes('model_provider = "old"'));

  const r2 = util.tomlUpsertTopKey(before, 'cli_auth_credentials_store', '"file"');
  const lines = r2.split('\n');
  const idxKey = lines.findIndex((l) => l.startsWith('cli_auth_credentials_store'));
  const idxSection = lines.findIndex((l) => l.startsWith('[section]'));
  assert.ok(idxKey >= 0 && idxKey < idxSection, '顶层键必须在表头之前，实际 idx=' + idxKey + ' section=' + idxSection);
});

t('tomlString：双引号与反斜杠被转义，换行被压掉（单行基本字符串）', () => {
  assert.strictEqual(util.tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.strictEqual(util.tomlString('a\nb'), '"a b"');
});

t('tomlReadTable / tomlUnquote：能读回表内值与去引号', () => {
  const text = '[model_providers.x]\nname = "N"\nbase_url = "http://a/v1"\n';
  const tb = util.tomlReadTable(text, 'model_providers.x');
  assert.strictEqual(util.tomlUnquote(tb.base_url), 'http://a/v1');
});

/* ==================== util：脱敏 ==================== */

t('util.redact：键名像密钥的整值打码；长串像密钥的打码；URL 不动', () => {
  const r = util.redact({
    OPENAI_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    baseURL: 'https://api.example.com/v1',
    nested: { token: 'zzz', plain: 'hello' },
  });
  assert.strictEqual(r.OPENAI_API_KEY, '<masked>');
  assert.strictEqual(r.baseURL, 'https://api.example.com/v1', 'URL 不该被打码');
  assert.strictEqual(r.nested.token, '<masked>');
  assert.strictEqual(r.nested.plain, 'hello');
});

/* ==================== models：必须与引擎规则一致 ==================== */

const SAMPLE_CFG = {
  port: 3091,
  apiKey: 'dsh-gateway-test-0123456789abcdef',
  providers: [
    {
      id: 'p1',
      baseURL: 'https://a/v1',
      apiKey: 'k',
      models: ['glm-5.2', { id: 'up/deepseek', as: 'deepseek-v4-flash', vision: true, contextWindow: 262144, maxTokens: 8192 }],
      priority: 1,
      enabled: true,
    },
    {
      id: 'p2',
      baseURL: 'https://b/v1',
      apiKey: 'k',
      models: [{ id: 'x', as: 'glm-5.2', contextWindow: 1048576 }, 'disabled-model'],
      priority: 2,
      enabled: false,          // 停用 → 它的模型不该出现
    },
  ],
};

t('models.collectModelNames：只统计启用的供应商，去重并排序', () => {
  const names = models.collectModelNames(SAMPLE_CFG);
  assert.deepStrictEqual(names, ['deepseek-v4-flash', 'glm-5.2']);
});

t('models.collectModels：上下文取所有家里的最小值（保守），vision 任一家声明即成立', () => {
  const cfg = JSON.parse(JSON.stringify(SAMPLE_CFG));
  cfg.providers[1].enabled = true;      // 启用 p2，glm-5.2 有两家
  const list = models.collectModels(cfg);
  const glm = list.find((m) => m.id === 'glm-5.2');
  assert.strictEqual(glm.contextWindow, 1048576);
  assert.deepStrictEqual(glm.providers.sort(), ['p1', 'p2']);
  const ds = list.find((m) => m.id === 'deepseek-v4-flash');
  assert.strictEqual(ds.vision, true);
  assert.strictEqual(ds.contextWindow, 262144);
});

t('models.modelEntries：别名 id/up/upstream/model 与 input:["text","image"] 都认', () => {
  const e = models.modelEntries({ models: [{ up: 'u1', alias: 'a1' }, { model: 'u2' }, { id: 'u3', input: ['text', 'image'] }] });
  assert.deepStrictEqual(e.map((x) => x.as), ['a1', 'u2', 'u3']);
  assert.ok(e[2].vision, 'input 含 image 应判定为 vision');
});

/* ==================== datadir：占位配置判定 ==================== */

const EXAMPLE_PATH = path.join(__dirname, '..', 'src', 'gateway', 'gateway.config.example.json');

t('datadir.isPlaceholderConfig：示例文件判为占位（含 workbuddy/cline 示范条目也不影响）', () => {
  const text = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  assert.strictEqual(datadir.isPlaceholderConfig(text), true);
});

t('datadir.isPlaceholderConfig：全停用 / 空 providers / 坏 JSON 都判为占位', () => {
  assert.strictEqual(datadir.isPlaceholderConfig('{}'), true);
  assert.strictEqual(datadir.isPlaceholderConfig('{oops'), true);
  assert.strictEqual(datadir.isPlaceholderConfig(JSON.stringify({
    providers: [{ id: 'real', baseURL: 'https://real.example.org/v1', apiKey: 'sk-' + 'a'.repeat(40), enabled: false }],
  })), true, '一家都没启用 → 占位');
});

t('datadir.isPlaceholderConfig：真实配置判为非占位', () => {
  const real = JSON.stringify({
    apiKey: 'dsh-gateway-' + 'a'.repeat(30),
    providers: [
      { id: 'provider-a', baseURL: 'https://api.example.com/v1', apiKey: 'sk-xxxxxxxx', enabled: true },
      { id: 'real-one', baseURL: 'https://relay.example.org/v1', apiKey: 'sk-' + 'b'.repeat(40), enabled: true },
    ],
  });
  assert.strictEqual(datadir.isPlaceholderConfig(real), false);
});

t('datadir.importGatewayConfig：目标已是真实配置时不动（返回 skipped）', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'dd-'));
  const real = JSON.stringify({
    apiKey: 'dsh-gateway-' + 'a'.repeat(30),
    providers: [{ id: 'real-one', baseURL: 'https://relay.example.org/v1', apiKey: 'sk-' + 'b'.repeat(40), enabled: true }],
  });
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), real, 'utf8');
  const r = datadir.importGatewayConfig(dir, [() => path.join(EXAMPLE_PATH)]);
  assert.strictEqual(r.action, 'skipped');
});

t('datadir.importGatewayConfig：目标是占位、来源真实 → 备份后导入', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'dd2-'));
  const target = path.join(dir, 'gateway.config.json');
  fs.writeFileSync(target, fs.readFileSync(EXAMPLE_PATH, 'utf8'), 'utf8');
  const srcDir = fs.mkdtempSync(path.join(tmp, 'dd2src-'));
  const src = path.join(srcDir, 'gateway.config.json');
  const real = JSON.stringify({
    apiKey: 'dsh-gateway-' + 'a'.repeat(30),
    providers: [{ id: 'real-one', baseURL: 'https://relay.example.org/v1', apiKey: 'sk-' + 'b'.repeat(40), enabled: true }],
  });
  fs.writeFileSync(src, real, 'utf8');
  const r = datadir.importGatewayConfig(dir, [() => src, () => EXAMPLE_PATH]);
  assert.strictEqual(r.action, 'upgraded');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), real);
  assert.ok(fs.existsSync(target + '.bak-import'), '覆盖前必须留备份');
});

/* ==================== probe：baseURL 归一 ==================== */

t('probe.upstreamBase：与引擎 upstreamBase 规则一致（补 /v1 / 收敛到 /vN）', () => {
  assert.strictEqual(probe.upstreamBase('https://a.com'), 'https://a.com/v1');
  assert.strictEqual(probe.upstreamBase('https://a.com/'), 'https://a.com/v1');
  assert.strictEqual(probe.upstreamBase('https://a.com/v1'), 'https://a.com/v1');
  assert.strictEqual(probe.upstreamBase('https://a.com/v1/chat/completions'), 'https://a.com/v1');
  assert.strictEqual(probe.upstreamBase('https://a.com/v2'), 'https://a.com/v2');
  assert.strictEqual(probe.upstreamBase(''), '');
});

t('probe.hostInList：裸后缀与点前缀都算命中，不误伤同后缀不同域名', () => {
  assert.strictEqual(probe.hostInList('api.cline.bot', ['cline.bot']), true);
  assert.strictEqual(probe.hostInList('api.cline.bot', ['.cline.bot']), true);
  assert.strictEqual(probe.hostInList('notcline.bot', ['cline.bot']), false);
  assert.strictEqual(probe.hostInList('cline.bot.evil.com', ['cline.bot']), false);
});

/* ==================== gateway-manager：配置校验 ==================== */

const OK_CFG = {
  port: 3091,
  apiKey: 'dsh-gateway-test-0123456789abcdef',
  providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m'] }],
};

t('validateConfigText：合法配置通过', () => {
  const r = validateConfigText(JSON.stringify(OK_CFG));
  assert.strictEqual(r.ok, true, r.error);
});

t('validateConfigText：apiKey 占位值/过短被拦（否则运行时全 401）', () => {
  const a = JSON.parse(JSON.stringify(OK_CFG)); a.apiKey = 'dsh-gateway-change-me';
  assert.strictEqual(validateConfigText(JSON.stringify(a)).ok, false);
  const b = JSON.parse(JSON.stringify(OK_CFG)); b.apiKey = 'short';
  assert.strictEqual(validateConfigText(JSON.stringify(b)).ok, false);
});

t('validateConfigText：供应商 id 重复被拦（熔断/目录状态会串味）', () => {
  const c = JSON.parse(JSON.stringify(OK_CFG));
  c.providers.push({ id: 'a', baseURL: 'https://b.com/v1', apiKey: 'k' });
  assert.strictEqual(validateConfigText(JSON.stringify(c)).ok, false);
});

t('validateConfigText：baseURL 缺 scheme 被拦（否则恒 503 且难与 key 错区分）', () => {
  const c = JSON.parse(JSON.stringify(OK_CFG));
  c.providers[0].baseURL = 'api.example.com/v1';
  assert.strictEqual(validateConfigText(JSON.stringify(c)).ok, false);
});

t('validateConfigText：enabled 是字符串 "false" 被拦（运行期会当成启用）', () => {
  const c = JSON.parse(JSON.stringify(OK_CFG));
  c.providers[0].enabled = 'false';
  assert.strictEqual(validateConfigText(JSON.stringify(c)).ok, false);
});

t('validateConfigText：本程序新增——routing / clientProfile / proxy 也要校验', () => {
  const a = JSON.parse(JSON.stringify(OK_CFG)); a.routing = 'roundrobin';
  assert.strictEqual(validateConfigText(JSON.stringify(a)).ok, false, 'routing 拼错应拦');
  const b = JSON.parse(JSON.stringify(OK_CFG)); b.clientProfile = 'claud';   // 少个 e
  assert.strictEqual(validateConfigText(JSON.stringify(b)).ok, false, 'clientProfile 拼错应拦');
  const c = JSON.parse(JSON.stringify(OK_CFG)); c.proxy = { enabled: true, url: '127.0.0.1:7890' };
  assert.strictEqual(validateConfigText(JSON.stringify(c)).ok, false, '代理地址缺 scheme 应拦');
  const d = JSON.parse(JSON.stringify(OK_CFG)); d.proxy = { enabled: true, url: 'http://127.0.0.1:7890' };
  assert.strictEqual(validateConfigText(JSON.stringify(d)).ok, true, validateConfigText(JSON.stringify(d)).error);
});

t('validateConfigText：正常取值一律放行（别把合法配置误拒）', () => {
  const c = JSON.parse(JSON.stringify(OK_CFG));
  c.routing = 'round-robin';
  c.clientProfile = 'cline';
  c.providers[0].quirks = ['force-stream', 'drop-thinking'];
  c.providers[0].protocol = 'openai-chat';
  c.providers[0].clientProfile = 'claude';
  c.providers[0].timeoutMs = 20000;
  c.providers[0].models = [{ id: 'u', as: 'l', vision: true, contextWindow: 1000, maxTokens: 100 }];
  const r = validateConfigText(JSON.stringify(c));
  assert.strictEqual(r.ok, true, r.error);
});

/* ==================== settings ==================== */

t('Settings：类型不符的补丁被忽略（字符串 "false" 不会反转布尔语义）', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'st-'));
  const s = new Settings(dir, () => {});
  s.save({ minimizeToTray: 'false' });
  assert.strictEqual(s.get('minimizeToTray'), true, '类型不符应被忽略，保持原值');
  s.save({ minimizeToTray: false });
  assert.strictEqual(s.get('minimizeToTray'), false);
});

t('Settings：坏 JSON 不阻断启动，改用默认值并留 .bak-broken', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'st2-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{broken', 'utf8');
  const s = new Settings(dir, () => {});
  assert.strictEqual(s.get('autoStartGateway'), true, '应回落默认值');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.bak-broken')));
});

/* ==================== logger / crash-report / winutil ==================== */

t('logger.maskSecrets：常见密钥前缀与裸 Bearer 都被打码', () => {
  const s = logger.maskSecrets('k=sk-abcdefghijklmnop t=nvapi-abcdefghijkl b=Bearer abcdefghijklmnop');
  assert.ok(!s.includes('sk-abcdefghijklmnop'));
  assert.ok(!s.includes('nvapi-abcdefghijkl'));
  assert.ok(!/Bearer abcdefghijklmnop/.test(s));
});

t('logger：写入与读取（含时区戳）', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'log-'));
  const lg = new logger.Logger(dir);
  process.env.LLM_GATEWAY_QUIET = '1';
  lg.info('hello');
  const tail = lg.tail();
  assert.ok(tail.includes('hello'));
  assert.ok(/UTC[+-]\d{2}:\d{2}/.test(tail), '日志必须带时区偏移');
  delete process.env.LLM_GATEWAY_QUIET;
});

t('crash-report：密钥字段被打码', () => {
  const cr = new crashReport.CrashReport(fs.mkdtempSync(path.join(tmp, 'cr-')), () => {});
  const p = cr.record('gateway', null, {
    phase: 'test',
    context: { exitCode: 1 },
    config: { apiKey: 'dsh-gateway-' + 'z'.repeat(30), providers: [{ id: 'a', apiKey: 'sk-' + 'y'.repeat(40) }] },
  });
  assert.ok(p && fs.existsSync(p));
  const saved = fs.readFileSync(p, 'utf8');
  assert.ok(!saved.includes('z'.repeat(30)), '统一 Key 不得落盘');
  assert.ok(!saved.includes('y'.repeat(40)), '供应商 Key 不得落盘');
  assert.ok(saved.includes('exitCode'), '非敏感上下文要保留');
});

/* ==================== 模型元数据与自动映射（一键获取模型） ==================== */

t('自动映射：去掉厂商前缀、保留 :free 这类有语义的后缀', () => {
  // 用户明确举的例子
  assert.strictEqual(modelMeta.autoMapName('deepseek-ai/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.strictEqual(modelMeta.autoMapName('z-ai/glm-5.3-flash'), 'glm-5.3-flash');
  // `:free` 决定走免费池还是付费池，**不能**去掉
  assert.strictEqual(modelMeta.autoMapName('google/gemma-4-26b-a4b-it:free'), 'gemma-4-26b-a4b-it:free');
  assert.strictEqual(modelMeta.autoMapName('nex-agi/nex-n2.5-pro:free'), 'nex-n2.5-pro:free');
  // 没有前缀 → 原样
  assert.strictEqual(modelMeta.autoMapName('Qwen3.8-Flash-Next'), 'Qwen3.8-Flash-Next');
  // 边界
  assert.strictEqual(modelMeta.autoMapName('/leading'), '/leading');
  assert.strictEqual(modelMeta.autoMapName('trailing/'), 'trailing/');
  assert.strictEqual(modelMeta.autoMapName(''), '');
  assert.strictEqual(modelMeta.autoMapName(null), '');
});

t('一键获取：上游只给 id 时靠已知表补参数；补不到就**留空**，绝不编一个数', () => {
  const r = modelMeta.enrichAll([
    { id: 'deepseek-ai/deepseek-v4.1-flash' },
    { id: 'brand-new-model-2099' },
  ]);
  const a = r.models.find((m) => m.id === 'deepseek-ai/deepseek-v4.1-flash');
  assert.strictEqual(a.as, 'deepseek-v4.1-flash');
  assert.strictEqual(a.contextWindow, 1048576, '已知表里有的应填上');
  assert.strictEqual(a.vision, true);

  const b = r.models.find((m) => m.id === 'brand-new-model-2099');
  assert.strictEqual(b.contextWindow, undefined, '不知道就必须留空 —— 虚报上下文会让客户端真的按那个数字发包');
  assert.strictEqual(b.maxTokens, undefined);
  assert.strictEqual(b.timeoutMs, undefined, '超时只能实测，不能猜');
  assert.deepStrictEqual(r.unknown, ['brand-new-model-2099'], '拿到不到参数的要在 unknown 里列出，界面据此提示用户');
});

t('一键获取：上游给了参数时**以上游为准**（即使与已知表不同）', () => {
  const r = modelMeta.enrichAll([{
    id: 'x/y',
    context_length: 32000,
    architecture: { input_modalities: ['text', 'image'] },
    top_provider: { max_completion_tokens: 4096 },
  }]);
  const m = r.models[0];
  assert.strictEqual(m.contextWindow, 32000);
  assert.strictEqual(m.maxTokens, 4096);
  assert.strictEqual(m.vision, true);
  // 已知表里 deepseek 是 1048576，上游说 65536 时要听上游的
  const r2 = modelMeta.enrichAll([{ id: 'deepseek-ai/deepseek-v4.1-flash', context_length: 65536 }]);
  assert.strictEqual(r2.models[0].contextWindow, 65536, '上游明说的值优先于内置表');
});

t('一键获取：各种中转的 /models 形态都要能解析', () => {
  // new-api/one-api：只有 id，什么都挖不到（也不该编）
  const bare = modelMeta.parseUpstreamMeta({ id: 'a', object: 'model', created: 1, owned_by: 'x' });
  assert.deepStrictEqual(bare, {}, '挖不到就该返回空对象，而不是填默认值');
  // 直接给 context_length / vision
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', context_length: 1000 }).contextWindow, 1000);
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', vision: true }).vision, true);
  // 塞在 metadata / limits 里
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', metadata: { context_window: 2000 } }).contextWindow, 2000);
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', limits: { max_output_tokens: 300 } }).maxTokens, 300);
  // 非法值不能当数字用
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', context_length: 0 }).contextWindow, undefined);
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', context_length: 'abc' }).contextWindow, undefined);
  assert.strictEqual(modelMeta.parseUpstreamMeta({ id: 'a', context_length: -5 }).contextWindow, undefined);
  assert.deepStrictEqual(modelMeta.parseUpstreamMeta(null), {});
  // 名字归一化：日期后缀 / :latest 都应被抹掉后再查表
  assert.strictEqual(modelMeta.normalizeModelName('vendor/gpt-4o-20240806'), 'gpt-4o');
  assert.strictEqual(modelMeta.normalizeModelName('vendor/GPT-4O:latest'), 'gpt-4o');
});

t('一键获取：同批里短名撞车必须能被检出（否则客户端会把两个模型当成同一个）', () => {
  const r = modelMeta.enrichAll([{ id: 'vendor-a/foo' }, { id: 'vendor-b/foo' }]);
  const names = r.models.map((m) => m.as || m.id);
  assert.deepStrictEqual(names, ['foo', 'foo'], '两个不同上游确实会映射成同一个短名');
  // 界面据此提示用户；这里只断言"确实会撞"，防止有人误以为去前缀总是安全的
  const dup = new Set(names).size !== names.length;
  assert.strictEqual(dup, true);
});

t('一键获取：重复的上游 ID 要去重', () => {
  const r = modelMeta.enrichAll([{ id: 'a/b' }, { id: 'a/b' }, { id: 'c/d' }]);
  assert.strictEqual(r.models.length, 2);
});

t('配置校验：逐模型 timeoutMs 必须是正数且有下限', () => {
  const base = { port: 3091, apiKey: 'lgw-' + 'a'.repeat(40), providers: [{ id: 'p1', baseURL: 'https://a.com/v1', apiKey: 'k' }] };
  const withTmo = (v) => validateConfigText(JSON.stringify(Object.assign({}, base, {
    providers: [{ id: 'p1', baseURL: 'https://a.com/v1', apiKey: 'k', models: [{ id: 'm1', timeoutMs: v }] }],
  })));
  assert.strictEqual(withTmo(20000).ok, true, '正数应放行');
  assert.strictEqual(withTmo(0).ok, false, '0 会被运行期判假、静默回落到供应商级 —— 必须拦下');
  assert.strictEqual(withTmo(-1).ok, false);
  assert.strictEqual(withTmo('abc').ok, false);
  assert.strictEqual(withTmo(500).ok, false, '小于 1 秒的超时没有意义，应拦下并说明');
  assert.strictEqual(validateConfigText(JSON.stringify(Object.assign({}, base, {
    providers: [{ id: 'p1', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }],
  }))).ok, true, '字符串形态的模型条目不该被这条校验误伤');
});

t('模型条目：逐模型 timeoutMs 必须被 writers 原样透出（否则一键写入会丢）', () => {
  const cfg = { providers: [{ id: 'p', models: [{ id: 'a/b', as: 'b', timeoutMs: 20000, vision: true }] }] };
  const e = models.modelEntries(cfg.providers[0]);
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].timeoutMs, 20000, 'timeoutMs 必须与 contextWindow/maxTokens 一样被带出');
  assert.strictEqual(e[0].vision, true);
});

/* ==================== IPC 兜底（结构性保障） ==================== */

t('主进程：所有 IPC handler 都必须走兜底包装（不许有裸的 ipcMain.handle）', () => {
  // 为什么钉这条：21 个 handler 里曾有 12 个没有 try/catch，任何一个抛出都会让
  // `ipcRenderer.invoke` 的 promise reject，渲染层那句 await 直接抛 ——
  // 用户看到的是"点了没反应"，没有任何提示。这是结构性修复，必须防止有人再加裸 handler。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const raw = src.match(/ipcMain\.handle\(/g) || [];
  assert.strictEqual(raw.length, 1,
    'main.js 里应当**只有**兜底包装内部那一处 ipcMain.handle，实际有 ' + raw.length + ' 处');
  const regs = src.match(/^\s+handle\('([^']+)'/gm) || [];
  assert.ok(regs.length >= 20, '应注册 20+ 个通道，实际 ' + regs.length);
});

t('主进程：兜底包装在 handler 抛出时返回 {ok:false,error}；对快照类通道返回 null', () => {
  // 把 main.js 里的 handle 定义抠出来，用一个假 ipcMain 跑一遍。
  // （main.js 本身需要 Electron，不能直接 require；但这段逻辑是纯函数。）
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const start = src.indexOf('const PLAIN_CHANNELS = new Set([');
  assert.ok(start > 0, '应能找到 PLAIN_CHANNELS');
  const end = src.indexOf('\n  handle(\'app:state\'', start);
  assert.ok(end > start, '应能找到兜底包装定义的结尾');
  const helperSrc = src.slice(start, end);

  const registered = new Map();
  const fakeIpc = { handle: (ch, fn) => registered.set(ch, fn) };
  const logs = [];
  const fakeLogger = { error: (m) => logs.push(m) };
  // eslint-disable-next-line no-new-func
  const build = new Function('ipcMain', 'logger', helperSrc + '\nreturn handle;');
  const handle = build(fakeIpc, fakeLogger);

  handle('gw:thing', () => { throw new Error('上游数据畸形'); });
  handle('app:state', () => { throw new Error('快照炸了'); });
  handle('gw:ok', () => ({ ok: true, value: 1 }));

  return Promise.all([
    registered.get('gw:thing')({}).then((r) => {
      assert.deepStrictEqual(r, { ok: false, error: '内部错误（gw:thing）：上游数据畸形' },
        '普通通道抛出时应回 {ok:false,error}，而不是让 IPC reject');
    }),
    registered.get('app:state')({}).then((r) => {
      assert.strictEqual(r, null, '快照类通道抛出时应回 null（渲染层已能容忍）');
    }),
    registered.get('gw:ok')({}).then((r) => {
      assert.deepStrictEqual(r, { ok: true, value: 1 }, '正常返回值不得被包装改变');
    }),
  ]).then(() => {
    assert.ok(logs.length === 2, '每次抛出都要记日志（app.log 里必须留线索）：' + JSON.stringify(logs));
    assert.ok(/gw:thing/.test(logs[0]) && /上游数据畸形/.test(logs[0]), '日志要带通道名与原因');
  });
});

t('winutil.prependPath：就地更新既有键，绝不新建大小写不同的重复键', () => {
  const env = { Path: 'C:\\Windows\\system32' };
  const key = winutil.prependPath(env, ['D:\\app']);
  assert.strictEqual(key, 'Path', '应命中既有的 Path 键');
  assert.strictEqual(Object.keys(env).filter((k) => k.toLowerCase() === 'path').length, 1, '只能有一个 path 键');
  assert.ok(env.Path.startsWith('D:\\app'));
  assert.ok(env.Path.includes('system32'), '原值必须保留');

  const env2 = {};
  assert.strictEqual(winutil.prependPath(env2, ['X']), 'PATH');
  assert.strictEqual(env2.PATH, 'X');
});

/* ==================== 代理字符串解析（实测踩过的三种误解析） ==================== */

const { normalizeProxyUrl, pickProxyFromRegistry } = require('../src/gateway-manager');

t('代理解析：注册表串必须按协议键取值（旧实现会把 https/socks/ftp 条目当 http 用）', () => {
  // 旧实现 `split(';')[0].split('=').pop()` 会拿第一段，于是：
  assert.strictEqual(pickProxyFromRegistry('https=127.0.0.1:7891;http=127.0.0.1:7890'), '127.0.0.1:7890',
    '有 http= 时必须优先取它，而不是第一个条目');
  assert.strictEqual(pickProxyFromRegistry('ftp=10.0.0.1:21;http=10.0.0.2:8080'), '10.0.0.2:8080',
    '不得把 FTP 代理当 HTTP 代理');
  assert.strictEqual(pickProxyFromRegistry('socks=127.0.0.1:1080'), '', '只认 http/https 键');
  assert.strictEqual(pickProxyFromRegistry('127.0.0.1:7890'), '127.0.0.1:7890', '裸 host:port 原样返回');
  // 密码里含 `=` 时不得在第一个 = 处截断
  assert.strictEqual(pickProxyFromRegistry('http=http://user:pa=ss@proxy.corp:8080'), 'http://user:pa=ss@proxy.corp:8080');
  assert.strictEqual(pickProxyFromRegistry(''), '');
});

t('代理解析：normalizeProxyUrl 补 scheme，已有 scheme 不动', () => {
  assert.strictEqual(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.strictEqual(normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.strictEqual(normalizeProxyUrl('  https://p:8443  '), 'https://p:8443');
  assert.strictEqual(normalizeProxyUrl(''), '');
  assert.strictEqual(normalizeProxyUrl(null), '');
});

t('校验：https:// 代理必须被拒（本程序的代理通道是明文 CONNECT，填了永远不可用）', () => {
  const base = { port: 3091, apiKey: 'dsh-gateway-test-0123456789abcdef', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k' }] };
  const r = validateConfigText(JSON.stringify(Object.assign({}, base, { proxy: { enabled: true, url: 'https://proxy.corp:8443' } })));
  assert.strictEqual(r.ok, false);
  assert.ok(/https/.test(r.error), '错误信息要说明原因：' + r.error);
  const ok = validateConfigText(JSON.stringify(Object.assign({}, base, { proxy: { enabled: true, url: 'http://127.0.0.1:7890' } })));
  assert.strictEqual(ok.ok, true, ok.error);
});

t('设置：__proto__ / constructor / prototype 之类的键不得被**写入**设置对象', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'proto-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    minimizeToTray: false, myOwnKey: 'keep-me', constructor: 'INJECTED-CTOR', prototype: 'INJECTED-PROTO',
  }), 'utf8');
  const s = new Settings(dir, () => {});
  assert.strictEqual(s.get('minimizeToTray'), false);
  assert.strictEqual(s.get('myOwnKey'), 'keep-me', '用户手写的普通未知键要保留');
  // 注意：`s.get('constructor')` 走原型链本来就会取到 Object 的构造函数，
  // 所以这里要断言的是"**自有属性**里没有它"，而不是 `get()` 返回 undefined。
  const own = (k) => Object.prototype.hasOwnProperty.call(s.data, k);
  assert.strictEqual(own('constructor'), false, 'constructor 不得被写进自有属性');
  assert.strictEqual(own('prototype'), false, 'prototype 不得被写进自有属性');
  assert.strictEqual(own('__proto__'), false, '__proto__ 不得被写进自有属性');
  assert.strictEqual(({}).polluted, undefined, '不得污染 Object.prototype');
  // 落盘的快照里也不该出现这些注入值
  const dumped = JSON.stringify(s.snapshot());
  assert.ok(!dumped.includes('INJECTED-CTOR') && !dumped.includes('INJECTED-PROTO'), '注入值不得进入快照：' + dumped);
});

/* ==================== 综合：模型清单与引擎写入一致 ==================== */

t('综合：models.collectModelNames 与引擎 --write-dsh 写进 dsh 的模型清单一致', () => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(tmp, 'parity-'));
  const cfgPath = path.join(dir, 'gateway.config.json');
  const setPath = path.join(dir, 'settings.yaml');
  const cfg = JSON.parse(JSON.stringify(SAMPLE_CFG));
  cfg.providers.forEach((p) => { p.enabled = true; });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const r = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'),
    '--write-dsh', '--config', cfgPath, '--settings', setPath,
    '--credentials', path.join(dir, 'c.yaml'), '--port', '3099',
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.strictEqual(r.status, 0, 'write-dsh 应成功：' + (r.stderr || r.stdout));
  const written = fs.readFileSync(setPath, 'utf8');
  const mine = models.collectModelNames(cfg);
  for (const m of mine) {
    assert.ok(written.includes(`- id: '${m}'`), `引擎写入里应含模型 ${m}`);
  }
  // 反向：引擎写入的模型条数应与我们算的一致（防止我们漏掉或多算）
  const engineIds = (written.match(/^ {8}- id: '(.*)'$/gm) || []).map((l) => l.replace(/^ {8}- id: '(.*)'$/, '$1'));
  assert.deepStrictEqual(engineIds, mine, '两边模型清单必须完全一致');
});

t('模型元数据：数值字段必须**类型严格 + 有上界**（旧实现放行 1e308 → 请求 1ms 被 abort）', () => {
  const meta = require('../src/model-meta');
  // 类型严格：Number(true)=1、Number([5])=5、Number('0x10')=16 都是 JS 的隐式转换陷阱
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: true }).contextWindow, undefined, 'true 不该变成 1');
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: [5] }).contextWindow, undefined, '[5] 不该变成 5');
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: '0x10' }).contextWindow, undefined, '0x10 不该变成 16');
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: -1 }).contextWindow, undefined);
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: Infinity }).contextWindow, undefined);

  // 上界：setTimeout 的上限是 2^31-1，超过会被 Node 悄悄改成 **1ms**
  // （TimeoutOverflowWarning）。实测 timeoutMs=1e308 时该模型每个请求都在 ~5ms 内被 abort，
  // 而 AbortError 不重试 → 反复失败最终把整家供应商熔断。
  assert.strictEqual(meta.enrichModel({ id: 'a/b', timeout_ms: 1e308 }).timeoutMs, 600000);
  assert.strictEqual(meta.enrichModel({ id: 'a/b', timeout_ms: 2147483648 }).timeoutMs, 600000);
  assert.strictEqual(meta.enrichModel({ id: 'a/b', timeout_ms: 30000 }).timeoutMs, 30000);
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: 1e308 }).contextWindow, 10000000);
  assert.strictEqual(meta.enrichModel({ id: 'a/b', context_length: 131072 }).contextWindow, 131072);
});

t('模型元数据：_src / _matchedBy 必须**可枚举**，否则过不了 Electron IPC', () => {
  const meta = require('../src/model-meta');
  const e = meta.enrichModel({ id: 'z-ai/glm-5.3-flash' });
  // 旧实现用 defineProperty(..., {enumerable:false})，而 IPC 走结构化克隆 ——
  // 不可枚举属性直接丢掉，于是界面上的「参数来源」提示在生产里**恒为空**。
  // 测试没抓到是因为原来的渲染层测试在同一进程里直调 enrichAll，从不跨 IPC。
  assert.ok(JSON.stringify(e).includes('"_src"'), '_src 必须能被 JSON 序列化');
  assert.notStrictEqual(structuredClone(e)._src, undefined, '_src 必须能过 structuredClone（≈IPC）');
  assert.deepStrictEqual(structuredClone(e)._src, e._src);
});

t('模型元数据：前缀命中要标成"按同族推测"，与精确命中区分开', () => {
  const meta = require('../src/model-meta');
  assert.strictEqual(meta.enrichModel({ id: 'z-ai/glm-5.3-flash' })._src.contextWindow, '已知表');
  assert.strictEqual(meta.enrichModel({ id: 'gpt-5.5-turbo' })._src.contextWindow, '已知表·按同族推测');
  assert.strictEqual(meta.enrichModel({ id: 'x/glm-5.3-flash', context_length: 999 })._src.contextWindow, '上游');
});

t('模型元数据：autoMapName 不得产出会写进配置的垃圾逻辑名', () => {
  const meta = require('../src/model-meta');
  // 这些结果会被**真的写进客户端配置**当逻辑模型名
  assert.strictEqual(meta.autoMapName('a//b'), 'a//b', '不能产出 /b');
  assert.strictEqual(meta.autoMapName('../../etc/passwd'), '../../etc/passwd', '不能产出 ../etc/passwd');
  assert.strictEqual(meta.autoMapName('.../...'), '.../...', '不能产出 ...');
  assert.strictEqual(meta.autoMapName('a/b/c'), 'a/b/c', '仍含分隔符则原样');
  // 正常情形不受影响
  assert.strictEqual(meta.autoMapName('deepseek-ai/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.strictEqual(meta.autoMapName('google/gemma-4-26b-a4b-it:free'), 'gemma-4-26b-a4b-it:free');
  assert.strictEqual(meta.autoMapName('Qwen3.8-Flash-Next'), 'Qwen3.8-Flash-Next');
});

t('配置校验：timeoutMs / contextWindow / maxTokens 必须有上界（下溢成 1ms = 让这家彻底不可用）', () => {
  const { validateConfigText } = require('../src/gateway-manager');
  const mk = (modelExtra, provExtra) => JSON.stringify({
    port: 3091,
    apiKey: 'lgw-' + 'a'.repeat(40),
    providers: [Object.assign({
      id: 'p', baseURL: 'https://a.com/v1', apiKey: 'k',
      models: [Object.assign({ id: 'm1' }, modelExtra)],
    }, provExtra || {})],
  });
  assert.strictEqual(validateConfigText(mk({ timeoutMs: 1e308 })).ok, false, '1e308 必须被拒');
  assert.strictEqual(validateConfigText(mk({ timeoutMs: 2147483648 })).ok, false, '2^31 必须被拒');
  assert.strictEqual(validateConfigText(mk({ timeoutMs: 600000 })).ok, true, '10 分钟应通过');
  assert.strictEqual(validateConfigText(mk({ timeoutMs: 20000 })).ok, true);
  assert.strictEqual(validateConfigText(mk({ timeoutMs: 999 })).ok, false, '太小要拒（会静默回落）');
  assert.strictEqual(validateConfigText(mk({ contextWindow: 1e308 })).ok, false);
  assert.strictEqual(validateConfigText(mk({}, { timeoutMs: 1e308 })).ok, false, '供应商级同样有上界');
  assert.strictEqual(validateConfigText(mk({}, { timeoutMs: 25000 })).ok, true);
});

t('日志着色：中文关键词必须能命中（`\\b` 对 CJK 不成立，旧实现全是死分支）', () => {
  // logs.js 是渲染层脚本，用一个最小沙箱加载它，只取 logLineClass
  const vm = require('vm');
  const logsSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'logs.js'), 'utf8');
  const sb = {
    console, JSON, String, Number, Math, RegExp, Array, Object, Date,
    document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {} }) },
    LG: { renders: {}, state: null, activeView: 'logs' }, $: () => null, $$: () => [], esc: (s) => String(s), toast: () => {},
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(logsSrc, sb, { filename: 'logs.js' });
  // 这些行都取自引擎真实会写出的内容
  assert.strictEqual(sb.logLineClass('[route] m: 1 个候选｜p=models-declared'), 'ok');
  assert.strictEqual(sb.logLineClass('[call] m all-providers status=ok dur=1330ms'), 'ok');
  assert.strictEqual(sb.logLineClass('breaker OPEN: amd 失败（network），熔断 3 分钟'), 'err', '中文"失败/熔断"必须标红');
  assert.strictEqual(sb.logLineClass('upstream p1 去 thinking 重试失败: x'), 'err');
  assert.strictEqual(sb.logLineClass('ReferenceError: dup is not defined (providers.js:382)'), 'err', 'ReferenceError 里的 Error 也要命中');
  assert.strictEqual(sb.logLineClass('provider p1: 2 个账户全部冷却中 → 交给下一家'), 'warn', '中文"冷却"必须标黄');
  assert.strictEqual(sb.logLineClass('upstream p1 HTTP 429: rate limited'), 'warn');
  assert.strictEqual(sb.logLineClass('[write-dsh] 已写入 settings.yaml'), 'hl');
  assert.strictEqual(sb.logLineClass('一键写入[claude-code]：成功'), 'hl', 'hl 要排在"成功"之前');
  assert.strictEqual(sb.logLineClass('数据目录：D:\\x'), '', '普通行不上色');
});

/* ==================== 应用图标 ==================== */

t('图标：所有尺寸与状态色都能渲染，且形状正确（圆角方块）', () => {
  const icon = require('../src/icon');
  for (const s of [16, 24, 32, 48, 64, 128, 256]) {
    const { buffer, width, height } = icon.renderIcon(s, icon.COLORS.brand);
    assert.strictEqual(width, s);
    assert.strictEqual(height, s);
    assert.strictEqual(buffer.length, s * s * 4, s + 'px 的 RGBA 长度应为 ' + s * s * 4);
    // 四角必须透明（圆角）—— 若哪天误改成实心方块，这条会立刻失败
    assert.strictEqual(buffer[3], 0, s + 'px 左上角应透明（圆角方块）');
    // 中心必须完全不透明
    const c = (((s >> 1) * s) + (s >> 1)) * 4;
    assert.strictEqual(buffer[c + 3], 255, s + 'px 中心应完全不透明');
  }
});

t('图标：边缘必须有半透明像素（超采样抗锯齿），不是硬阈值', () => {
  const icon = require('../src/icon');
  const s = 64;
  const { buffer } = icon.renderIcon(s, icon.COLORS.brand);
  let partial = 0;
  for (let i = 3; i < buffer.length; i += 4) {
    const a = buffer[i];
    if (a > 0 && a < 255) partial++;
  }
  // 旧实现是逐像素硬阈值 → 这里恒为 0，于是 16/24px 下圆角与字形边缘全是锯齿。
  assert.ok(partial > s, '应有数百个半透明边缘像素（抗锯齿），实际 ' + partial);
});

t('图标：各状态色互不相同，且 brand 与界面 --accent 严格一致', () => {
  const icon = require('../src/icon');
  const seen = new Map();
  for (const [name, rgb] of Object.entries(icon.COLORS)) {
    // ⚠ 不能取 buffer 开头 —— 那是透明角，RGB 恒为 (0,0,0)，会让所有颜色"撞车"；
    // 也不能手算坐标 —— 容易落进白色的字形里。
    // 稳妥做法：扫一遍，取第一个"不透明且不是字形白"的像素，那就是底色。
    const s = 32;
    const buf = icon.renderIcon(s, rgb).buffer;
    let key = null;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] !== 255) continue;                                  // 抗锯齿边缘
      if (buf[i] === 255 && buf[i + 1] === 255 && buf[i + 2] === 255) continue;  // 字形
      key = buf[i] + ',' + buf[i + 1] + ',' + buf[i + 2];
      break;
    }
    assert.ok(key, name + ' 应能找到一个底色像素');
    assert.ok(!seen.has(key), name + ' 与 ' + seen.get(key) + ' 的配色撞了（都是 ' + key + '）');
    seen.set(key, name);
  }
  // 图标主色必须等于 renderer/styles.css 的 --accent，否则会出现"图标深蓝、按钮亮蓝"
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const m = /--accent:\s*#([0-9a-f]{6})/i.exec(css);
  assert.ok(m, 'styles.css 里应能找到 --accent');
  const hex = m[1];
  const rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  assert.deepStrictEqual(icon.COLORS.brand, rgb,
    '图标品牌色应与界面 --accent 一致：图标 ' + JSON.stringify(icon.COLORS.brand) + ' vs CSS ' + JSON.stringify(rgb));
});

t('图标：ICO 容器结构正确（PNG-in-ICO，多尺寸条目）', () => {
  const icon = require('../src/icon');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = icon.iconIcoBuffer(icon.COLORS.brand, sizes);
  assert.strictEqual(ico.readUInt16LE(0), 0, 'reserved 应为 0');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'type 应为 1（icon）');
  assert.strictEqual(ico.readUInt16LE(4), sizes.length, '条目数应与请求的尺寸数一致');
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (let i = 0; i < sizes.length; i++) {
    const e = 6 + i * 16;
    const s = sizes[i];
    assert.strictEqual(ico[e], s >= 256 ? 0 : s, '第 ' + i + ' 条的宽度字节');
    assert.strictEqual(ico[e + 1], s >= 256 ? 0 : s, '第 ' + i + ' 条的高度字节');
    assert.strictEqual(ico.readUInt16LE(e + 6), 32, '第 ' + i + ' 条应为 32bpp');
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    assert.ok(off + len <= ico.length, '第 ' + i + ' 条的偏移+长度不能越界');
    assert.ok(ico.subarray(off, off + 4).equals(PNG_SIG), '第 ' + i + ' 条的数据应以 PNG 签名开头');
  }
});

t('界面品牌标记：index.html 的内联 SVG 必须与 src/icon.js 的几何**逐点一致**', () => {
  // 为什么要有这条：界面左上角那个方块曾经是"纯 CSS 渐变"，与应用图标毫无关系 ——
  // 换图标时它纹丝不动（用户实测发现）。现在改成内联 SVG 复刻图标，
  // 但"两处必须同步"光靠注释是守不住的（我写完那句注释之后自己还是漏改过一次）。
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const icon = require('../src/icon');
  const G = icon.GEOMETRY;

  const svg = /<svg class="logo"[\s\S]*?<\/svg>/.exec(html);
  assert.ok(svg, 'index.html 里应有 <svg class="logo"> 品牌标记');
  const s = svg[0];
  const flat = s.replace(/\s+/g, ' ');

  // 100 单位视图盒 → 归一化坐标 ×100；去掉浮点尾巴便于比对
  const n = (v) => String(Math.round(v * 1000) / 1000);
  const P = G.PAD * 100;
  const side = (1 - 2 * G.PAD) * 100;

  assert.strictEqual(n(0), '0');
  assert.ok(flat.includes(`x="${n(P)}" y="${n(P)}"`), '方块起点应为 PAD（' + n(P) + '）');
  assert.ok(flat.includes(`width="${n(side)}" height="${n(side)}"`), '方块边长应为 ' + n(side));
  assert.ok(flat.includes(`rx="${n(G.TILE_R * 100)}"`), '圆角半径应为 ' + n(G.TILE_R * 100));
  assert.ok(flat.includes(`stroke-width="${n(G.STEM_R * 200)}"`), '笔画宽度应为 ' + n(G.STEM_R * 200));

  // 三条胶囊：M x1 y1 L x2 y2
  const caps = [...flat.matchAll(/<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)"\/>/g)]
    .map((m) => m.slice(1).map(Number));
  assert.strictEqual(caps.length, G.CAPS.length, '胶囊数量应与 icon.js 一致');
  G.CAPS.forEach((c, i) => {
    const want = [c[0] * 100, c[1] * 100, c[2] * 100, c[3] * 100].map((v) => Number(n(v)));
    assert.deepStrictEqual(caps[i], want, '第 ' + (i + 1) + ' 条胶囊坐标不一致');
  });

  // 箭头三角：tip(tipX,tipY)，底边 x = (tipX-w)，上下 y = tipY ± h
  const tri = /<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) Z" fill="#fff"\/>/.exec(flat);
  assert.ok(tri, '应有箭头三角路径');
  const A = G.ARROW;
  const wantTri = [A.tipX * 100, A.tipY * 100, (A.tipX - A.w) * 100, (A.tipY - A.h) * 100, (A.tipX - A.w) * 100, (A.tipY + A.h) * 100]
    .map((v) => Number(n(v)));
  assert.deepStrictEqual(tri.slice(1).map(Number), wantTri, '箭头三角坐标不一致');

  // 渐变两端：brand 与"压暗 GRADIENT_DARKEN"，与 icon.js 的 darken() 同口径
  const stops = [...flat.matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
  assert.strictEqual(stops.length, 2, '应有两个渐变色标');
  const hex = (rgb) => '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
  assert.strictEqual(stops[0], hex(icon.COLORS.brand), '渐变的亮端应等于 COLORS.brand');
  const dark = icon.COLORS.brand.map((c) => Math.round(c * (1 - G.GRADIENT_DARKEN)));
  assert.strictEqual(stops[1], hex(dark), '渐变的暗端应等于 brand 压暗 ' + G.GRADIENT_DARKEN);
});

t('图标：PNG 编码合法（签名 + IHDR 尺寸 + IEND 结尾）', () => {
  const icon = require('../src/icon');
  const png = icon.iconPngBuffer(48, icon.COLORS.ready);
  assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 签名');
  assert.strictEqual(png.readUInt32BE(16), 48, 'IHDR 宽度');
  assert.strictEqual(png.readUInt32BE(20), 48, 'IHDR 高度');
  assert.strictEqual(png[24], 8, '位深 8');
  assert.strictEqual(png[25], 6, '颜色类型 6（RGBA）');
  assert.ok(png.subarray(-8).includes(Buffer.from('IEND')), '应以 IEND 结尾');
  const url = icon.iconDataURL(16, icon.COLORS.stopped);
  assert.ok(url.startsWith('data:image/png;base64,'), 'dataURL 前缀');
});

run();
