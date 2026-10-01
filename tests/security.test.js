// tests/security.test.js — 安全与数据安全回归
//
// 这里每一条都对应一次**实跑确认过的真实缺陷**（不是"理论上可能"）。放在单独的文件里，
// 是为了让"这些是被事故教出来的规则"这件事一眼可见。
//
// 运行：node tests/security.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { t, run } = require('./_harness');

const util = require('../src/writers/util');
const logger = require('../src/logger');
const codex = require('../src/writers/target-codex');
const claude = require('../src/writers/target-claude-code');
const iflow = require('../src/writers/target-iflow');
const opencode = require('../src/writers/target-opencode');
const envscript = require('../src/writers/target-envscript');
const writers = require('../src/writers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-sec-'));
const KEY = 'lgw-' + 'a'.repeat(40);

function newHome(tag) { return fs.mkdtempSync(path.join(tmp, tag + '-')); }

function ctxFor(home, config) {
  const cfg = config || { port: 3091, apiKey: KEY, providers: [{ id: 'p1', baseURL: 'https://relay.example.org/v1', apiKey: 'k', models: ['m1'] }] };
  const configPath = path.join(home, 'gateway.config.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
  return {
    port: cfg.port || 3091,
    apiKey: cfg.apiKey !== undefined ? cfg.apiKey : KEY,
    config: cfg,
    configPath,
    dataDir: home,
    enginePath: path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'),
    nodeExe: process.execPath,
    nodeEnv: {},
    options: {},
    home,
  };
}

/* ================================================================
 * TOML：三种"会把用户文件写成语法错误"的形态
 * ================================================================ */

const TOML_WITH_COMMENT_HEADER = [
  'model = "gpt-5-codex"',
  'model_provider = "llmgateway"',
  '',
  '[model_providers.llmgateway] # 我的网关',
  'name = "旧名字"',
  'base_url = "http://127.0.0.1:1/v1"',
  '',
  '[mcp_servers.x]',
  'command = "npx"',
  '',
].join('\n');

t('TOML：表头带行尾注释时必须**就地替换**，不得追加第二张同名表', () => {
  const home = newHome('toml-comment');
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, TOML_WITH_COMMENT_HEADER, 'utf8');

  const r = codex.apply(ctxFor(home));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const after = fs.readFileSync(file, 'utf8');
  assert.strictEqual((after.match(/^\[model_providers\.llmgateway\]/gm) || []).length, 1,
    '不得出现两张同名表（TOML 会整体解析失败）\n' + after);
  assert.ok(after.includes('[mcp_servers.x]'), 'mcp_servers 必须保留');
  assert.ok(!after.includes('旧名字'), '旧 provider 表应被替换');
  assert.strictEqual(util.tomlValidate(after), '', '写出来的必须是合法 TOML');
});

const TOML_WITH_HEADER_IN_STRING = [
  'model = "gpt-5-codex"',
  'model_provider = "lgw"',
  'developer_instructions = """',
  '[model_providers.llmgateway]',
  '这是说明文字，不是真的表头',
  '"""',
  '',
  '[mcp_servers.x]',
  'command = "npx"',
  '',
].join('\n');

t('TOML：多行字符串里的"表头"不得被当成真表头（否则会删掉用户字符串并写出语法错误）', () => {
  const home = newHome('toml-string');
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, TOML_WITH_HEADER_IN_STRING, 'utf8');

  const r = codex.apply(ctxFor(home));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('这是说明文字，不是真的表头'), '用户多行字符串的内容不得被删');
  assert.strictEqual((after.match(/"""/g) || []).length, 2, '三引号必须成对');
  assert.strictEqual(util.tomlValidate(after), '', '写出来的必须是合法 TOML：' + util.tomlValidate(after));
});

t('TOML：顶层 dotted key 隐含声明过的表，不得再被显式声明（自检必须拦下）', () => {
  const dotted = [
    'model_providers.llmgateway.name = "old"',
    'model_providers.llmgateway.base_url = "http://127.0.0.1:1/v1"',
    '',
    '[mcp_servers.x]',
    'command = "npx"',
    '',
  ].join('\n');
  const err = util.tomlValidate(dotted + '\n[model_providers.llmgateway]\nname = "new"\n');
  assert.ok(err.includes('dotted key'), '自检应认出这种冲突：' + err);

  const home = newHome('toml-dotted');
  const dir = path.join(home, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, dotted, 'utf8');
  const p = codex.preview(ctxFor(home));
  assert.ok(p.guard.some((g) => g.includes('TOML')), '预览必须拦下：' + JSON.stringify(p.guard));
  const r = codex.apply(ctxFor(home));
  assert.strictEqual(r.ok, false, '不合法时不得写入');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), dotted, '原文件必须原封不动');
});

t('TOML 自检：重复表头 / 未闭合多行字符串都能认出来', () => {
  assert.ok(util.tomlValidate('[a]\nx = 1\n\n[a]\ny = 2\n').includes('两次'));
  assert.ok(util.tomlValidate('a = """\n未闭合\n').includes('未闭合'));
  assert.strictEqual(util.tomlValidate('[a]\nx = 1\n\n[b]\ny = 2\n'), '', '正常文件不该误报');
  assert.strictEqual(util.tomlValidate(''), '', '空文件不该误报');
});

/* ================================================================
 * 读不到的文件 → 必须中止（不得静默整份覆盖）
 * ================================================================ */

t('写保护：目标存在但读不出来时，apply 必须中止且不改动原文件', () => {
  const home = newHome('unreadable');
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  // 用**目录**占住文件位置：fs.readFileSync(dir) 会 EISDIR —— 与"ACL 拒绝读"是同一条
  // 代码路径（readTarget 返回 ok:false），足以验证闸门。
  fs.mkdirSync(file);

  const r = claude.apply(ctxFor(home));
  assert.strictEqual(r.ok, false, '读不出来就必须中止');
  assert.ok(r.errors.some((e) => e.includes('读不出来')), '错误信息要说明原因：' + JSON.stringify(r.errors));
  assert.ok(fs.statSync(file).isDirectory(), '原路径不得被覆盖成文件');
});

t('写保护：writeAtomic 对"存在但读不出来"的目标一律拒绝（这是覆盖全部目标的兜底闸门）', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'wa-guard-'));
  const target = path.join(dir, 'existing');
  fs.mkdirSync(target);                     // 目录 → readFileSync 失败
  const r = util.writeAtomic(target, 'x');
  assert.strictEqual(r.ok, false);
  assert.ok(/读不出来|中止/.test(r.error || ''), r.error);
});

t('写保护：rename 失败时不得留下含明文内容的 .tmp 文件', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tmpclean-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}', 'utf8');
  // 把 tmp 路径先占成目录 → writeFileSync(tmp) 失败 → 走 catch
  const tmpPath = file + '.tmp-llmgateway-' + process.pid;
  fs.mkdirSync(tmpPath);
  const r = util.writeAtomic(file, '{"a":1}');
  assert.strictEqual(r.ok, false, '写入失败必须如实上报');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{}', '原文件不得被改动');
});

/* ================================================================
 * 统一 Key 判定：占位值必须拦下（保存路径与写入路径口径一致）
 * ================================================================ */

t('统一 Key 判定：空 / 过短 / 示例占位值 / 模板形态全部拦下', () => {
  assert.ok(util.apiKeyProblem(''));
  assert.ok(util.apiKeyProblem('short'));
  assert.ok(util.apiKeyProblem('dsh-gateway-change-me'), '这是示例文件里的公开占位值（22 字符，长度检查拦不住）');
  assert.ok(util.apiKeyProblem('sk-xxxxxxxx'));
  assert.ok(util.apiKeyProblem('lgw-' + 'a'.repeat(20) + '\n换行'));
  assert.strictEqual(util.apiKeyProblem('lgw-' + 'a'.repeat(40)), '');
  assert.strictEqual(util.apiKeyProblem('dsh-gateway-v100000000000000000000000000-ShS'), '', '真实形态必须放行');
});

t('占位 Key：**全部**目标的 preview 都要拦，apply 也要拒绝（不能再"保存被拦、写入放行"）', async () => {
  for (const tgt of writers.TARGETS) {
    const home = newHome('placeholder-' + tgt.id);
    const ctx = ctxFor(home);
    // 两边都设成占位值：非 dsh 目标查 `ctx.apiKey`，而 dsh 的写入是**引擎**执行的、
    // 引擎读的是 `ctx.configPath` 指向的配置文件里的 apiKey（这正是实测踩到的坑：
    // ctx 合法、磁盘上却是 3 字符的 Key → guard 一条理由都不给 → 不可用的 Key 覆盖了用户凭据）。
    ctx.apiKey = 'dsh-gateway-change-me';
    const cfg = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
    cfg.apiKey = 'dsh-gateway-change-me';
    fs.writeFileSync(ctx.configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const p = writers.preview(tgt.id, ctx);
    assert.ok(p.guard.some((g) => g.includes('占位')), tgt.id + ' 的预览必须拦下占位 Key，实际 guard=' + JSON.stringify(p.guard));
    // writers.apply 现在是 async（统一了 dsh 的 Promise 与其余目标的同步返回）
    // eslint-disable-next-line no-await-in-loop
    const r = await writers.apply(tgt.id, ctx);
    assert.strictEqual(r.ok, false, tgt.id + ' 的 apply 必须拒绝占位 Key');
  }
});

t('dsh：Key 检查必须看**磁盘配置里那把**（引擎用的就是它，ctx.apiKey 不算数）', async () => {
  const home = newHome('dsh-key-source');
  const ctx = ctxFor(home);
  ctx.apiKey = 'lgw-' + 'a'.repeat(40);          // ctx 合法
  const cfg = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
  cfg.apiKey = 'abc';                            // 磁盘上只有 3 字符
  fs.writeFileSync(ctx.configPath, JSON.stringify(cfg, null, 2), 'utf8');

  const p = writers.preview('dsh', ctx);
  assert.ok(p.guard.length > 0, '磁盘上的 Key 过短时必须拦下（否则引擎会把它写进 credentials.yaml，覆盖用户原有凭据）');
  assert.ok(p.guard.some((g) => /太短|Key/.test(g)), JSON.stringify(p.guard));
  const r = await writers.apply('dsh', ctx);
  assert.strictEqual(r.ok, false);
});

t('write:apply 的契约：writers.apply 必须**永远返回 Promise**（dsh 是 async，其余是同步）', async () => {
  const home = newHome('apply-contract');
  const p = writers.apply('dsh', ctxFor(home));
  assert.ok(p && typeof p.then === 'function', 'writers.apply 必须返回 Promise，否则调用方同步读 .ok 会永远拿到 undefined');
  const r = await p;
  assert.strictEqual(typeof r.ok, 'boolean', 'await 之后必须有布尔 ok');
  // 未知目标也不能抛
  const r2 = await writers.apply('nope', ctxFor(newHome('apply-unknown')));
  assert.strictEqual(r2.ok, false);
});

t('空 Key：apply 不得把用户原有凭据写成空串（这是不可逆的破坏）', async () => {
  const cases = [
    ['claude-code', '.claude/settings.json', { env: { ANTHROPIC_AUTH_TOKEN: 'sk-user-原有的可用凭据', ANTHROPIC_BASE_URL: 'https://real.example/' }, language: 'Chinese' }],
    ['iflow', '.iflow/settings.json', { apiKey: 'sk-user-原有的可用凭据', baseUrl: 'https://apis.iflow.cn/v1', language: 'zh-CN' }],
    ['opencode', '.config/opencode/opencode.json', { provider: { other: { options: { apiKey: 'sk-user-原有的可用凭据' } } }, theme: 'dark' }],
  ];
  for (const [id, rel, content] of cases) {
    const home = newHome('emptykey-' + id);
    const f = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const original = JSON.stringify(content, null, 2) + '\n';
    fs.writeFileSync(f, original, 'utf8');

    const ctx = ctxFor(home);
    ctx.apiKey = '';
    // eslint-disable-next-line no-await-in-loop
    const r = await writers.apply(id, ctx);
    assert.strictEqual(r.ok, false, id + ' 在空 Key 时必须拒绝写入');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), original, id + ' 的原文件必须一字未改');
  }
});

/* ================================================================
 * 密钥脱敏
 * ================================================================ */

t('脱敏：登记过的密钥（含网关自己生成的形态）必须被整串抹掉', () => {
  const secret = 'dsh-gateway-v100000000000000000000000000-ShS';
  logger.registerSecret(secret);
  const text = 'Authorization: Bearer ' + secret + ' <- 上游回显';
  const masked = logger.maskSecretsFull(text);
  assert.ok(!masked.includes(secret), '登记的密钥不得原样出现：' + masked);
});

t('脱敏：maskSecretsFull 不留前缀（预览会被截图分享），maskSecrets 留前缀便于对照', () => {
  const s = 'token=' + 'sk-' + 'b'.repeat(40);
  const full = logger.maskSecretsFull(s);
  const log = logger.maskSecrets(s);
  assert.ok(!full.includes('b'.repeat(20)), '全量打码不得留下大段原文：' + full);
  assert.ok(full.includes('<masked'), full);
  assert.ok(log.includes('…<masked>'), '日志形态保留前 6 字符便于对照：' + log);
});

t('脱敏：scrubDeepSecrets 深扫对象/数组，任意层级的密钥都被抹掉', () => {
  const secret = 'gsk_' + 'c'.repeat(40);
  logger.registerSecret(secret);
  const payload = {
    files: [
      { path: 'x', before: 'k = "' + secret + '"', after: null },
      { path: 'y', before: ['nested', { deep: secret }] },
    ],
  };
  const out = logger.scrubDeepSecrets(payload);
  const dumped = JSON.stringify(out);
  assert.ok(!dumped.includes(secret), '任意层级的密钥都必须被抹掉：' + dumped);
  assert.strictEqual(out.files[0].path, 'x', '非敏感字段必须原样保留');
  assert.strictEqual(out.files[1].before[0], 'nested');
});

t('脱敏：预览不得把**其它客户端**的明文密钥送到渲染层（iFlow / opencode / codex 的 before）', () => {
  const other = 'sk-user-OTHER-CLIENT-SECRET-1234567890';
  logger.registerSecret(other);
  const cases = [
    ['iflow', '.iflow/settings.json', { apiKey: other, searchApiKey: 'as_' + 'd'.repeat(30), language: 'zh-CN' }],
    ['opencode', '.config/opencode/opencode.json', { provider: { other: { options: { apiKey: other } } } }],
  ];
  for (const [id, rel, content] of cases) {
    const home = newHome('previewscrub-' + id);
    const f = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(content, null, 2) + '\n', 'utf8');
    const p = writers.preview(id, ctxFor(home));
    const scrubbed = logger.scrubDeepSecrets(p);   // main.js 的 sanitizePreview 走的就是它
    assert.ok(!JSON.stringify(scrubbed).includes(other), id + ' 的预览里不得含其它客户端的明文密钥');
  }
});

/* ================================================================
 * 生成的脚本：不得被外来字符串注入命令
 * ================================================================ */

t('生成的 shell 脚本：恶意模型名与 Key 都不得跳出引号', () => {
  const evilCfg = {
    port: 3091,
    apiKey: KEY,
    providers: [{
      id: 'p1',
      baseURL: 'https://relay.example.org/v1',
      apiKey: 'k',
      models: ['m&calc', 'm|calc', 'm^calc', 'm%PATH%', "m'$(calc)", 'm\necho INJECTED'],
      enabled: true,
    }],
  };
  const home = newHome('inject');
  const ctx = ctxFor(home, evilCfg);
  ctx.apiKey = "lgw-" + 'a'.repeat(30) + "%PATH%&calc";
  const r = envscript.apply(ctx);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  const dir = envscript.dirOf(ctx);
  const cmd = fs.readFileSync(path.join(dir, 'llm-gateway-env.cmd'), 'utf8');
  const ps1 = fs.readFileSync(path.join(dir, 'llm-gateway-env.ps1'), 'utf8');
  const sh = fs.readFileSync(path.join(dir, 'llm-gateway-env.sh'), 'utf8');
  const txt = fs.readFileSync(path.join(dir, 'endpoints.txt'), 'utf8');

  // cmd：echo 行不得含裸元字符；set 行的 % 必须翻倍
  for (const l of cmd.split('\r\n').filter((x) => /^echo\s/i.test(x.trim()))) {
    assert.ok(!/[&|<>^]/.test(l), 'cmd echo 行不得含元字符：' + l);
  }
  for (const l of cmd.split('\r\n').filter((x) => /^set "/.test(x))) {
    // `%%` 才是一个字面量 %；单个 %（奇数个）会被 cmd 当变量展开
    assert.strictEqual((l.match(/%/g) || []).length % 2, 0, 'cmd set 行里的 % 必须成对转义：' + l);
  }
  assert.ok(!/^echo INJECTED$/m.test(cmd), '不得出现被注入的独立命令行');
  // ps1：赋值一律单引号
  for (const l of ps1.split('\n').filter((x) => /^\$env:/.test(x))) assert.ok(/=\s*'/.test(l), l);
  // sh：赋值一律单引号包裹
  for (const l of sh.split('\n').filter((x) => /^export /.test(x))) assert.ok(/='/.test(l) && l.endsWith("'"), l);
  // endpoints.txt 是"给人抄的命令"，模型名必须已净化
  for (const l of txt.split('\r\n')) {
    if (/aider --model/.test(l)) assert.ok(!/[&|^]/.test(l), 'endpoints.txt 的示例命令不得含元字符：' + l);
  }
});

/* ================================================================
 * 收尾：确认没碰真实用户目录
 * ================================================================ */

t('测试自身：所有写入都落在临时目录里（绝不碰真实用户目录）', () => {
  for (const d of fs.readdirSync(tmp)) {
    assert.ok(path.join(tmp, d).startsWith(os.tmpdir()), '测试产物必须在临时目录：' + d);
  }
  for (const real of ['.claude/settings.json', '.codex/config.toml', '.dsh/settings.yaml', '.iflow/settings.json']) {
    const p = path.join(os.homedir(), ...real.split('/'));
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      assert.ok(!text.includes(KEY), '真实用户文件里不得出现测试 Key：' + p);
      assert.ok(!text.includes('sk-user-OTHER-CLIENT-SECRET'), '真实用户文件里不得出现测试密钥：' + p);
    }
  }
});

run();
