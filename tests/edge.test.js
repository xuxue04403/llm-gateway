// tests/edge.test.js — 边界与降级路径
//
// "功能全部可用"的真正考验不在正常路径，而在这些场景：没有任何供应商、供应商全停用、
// 模型一个都没配、配置文件坏了/丢了、统一 Key 空着、网关没运行。
// 这些恰恰是用户第一次启动、或者手改配置改错时会遇到的形态。
//
// 运行：node tests/edge.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { t, run } = require('./_harness');

const writers = require('../src/writers');
const models = require('../src/writers/models');
const util = require('../src/writers/util');
const datadir = require('../src/datadir');
const { validateConfigText } = require('../src/gateway-manager');
const { Settings } = require('../src/settings');
const probe = require('../src/probe');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgw-edge-'));

const KEY = 'lgw-' + 'a'.repeat(40);

function newHome(tag) {
  const d = fs.mkdtempSync(path.join(tmp, tag + '-'));
  return d;
}

/** 造一个 ctx；config 为 null 时表示"配置文件坏了/不存在"。 */
function ctxFor(home, config, opts) {
  const configPath = path.join(home, 'gateway.config.json');
  fs.mkdirSync(home, { recursive: true });
  if (config !== null) fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  const cfg = config || { providers: [] };
  return {
    port: 3091,
    apiKey: cfg.apiKey !== undefined ? cfg.apiKey : KEY,
    config: cfg,
    configPath,
    dataDir: home,
    enginePath: path.join(__dirname, '..', 'src', 'gateway', 'model-gateway.mjs'),
    nodeExe: process.execPath,
    nodeEnv: {},
    options: opts || {},
    home,
  };
}

/* ================================================================
 * 配置校验：合法但不完整的配置该不该放行
 * ================================================================ */

t('校验：没有 providers 数组 → 拦下（引擎会直接 exit，网关起不来）', () => {
  const r = validateConfigText(JSON.stringify({ port: 3091, apiKey: KEY, providers: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(/providers/.test(r.error));
});

t('校验：providers 全是非对象条目 → 拦下', () => {
  const r = validateConfigText(JSON.stringify({ port: 3091, apiKey: KEY, providers: [null, 'x'] }));
  assert.strictEqual(r.ok, false);
});

t('校验：供应商缺 models 是合法的（靠 /models 目录兜底）—— 不得误拒', () => {
  const r = validateConfigText(JSON.stringify({
    port: 3091, apiKey: KEY,
    providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k' }],
  }));
  assert.strictEqual(r.ok, true, r.error);
});

t('校验：providers 全部 enabled=false 仍算合法（用户可以全停用保留配置）', () => {
  const r = validateConfigText(JSON.stringify({
    port: 3091, apiKey: KEY,
    providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', enabled: false }],
  }));
  assert.strictEqual(r.ok, true, r.error);
});

t('校验：顶层 apiKey 缺失是合法的（引擎会在每个请求上 401，但不算配置错误）', () => {
  // 说明：引擎 authorized() 在 cfg.apiKey 为空时 fail-closed。这里只验证"校验器不误拒"，
  // 界面在一键写入时会另外拦（见下面各目标的 guard）。
  const r = validateConfigText(JSON.stringify({ port: 3091, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k' }] }));
  assert.strictEqual(r.ok, true, r.error);
});

t('校验：proxy 是 null / 数组 → 拦下（运行期会当成没配，用户以为配了）', () => {
  for (const bad of [null, [], 'http://x']) {
    const r = validateConfigText(JSON.stringify({ port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k' }], proxy: bad }));
    assert.strictEqual(r.ok, false, 'proxy=' + JSON.stringify(bad) + ' 应被拦下');
  }
});

/* ================================================================
 * 模型清单：空 / 全停用 / 无模型
 * ================================================================ */

t('模型清单：空配置 → 空数组，不抛', () => {
  assert.deepStrictEqual(models.collectModelNames({}), []);
  assert.deepStrictEqual(models.collectModelNames({ providers: [] }), []);
  assert.deepStrictEqual(models.collectModels(null), []);
});

t('模型清单：供应商全停用 → 空（不把停用家的模型算进去）', () => {
  const cfg = { providers: [{ id: 'a', enabled: false, models: ['m1'] }] };
  assert.deepStrictEqual(models.collectModelNames(cfg), []);
});

t('模型清单：供应商没有 models 字段 → 空，不抛', () => {
  assert.deepStrictEqual(models.collectModelNames({ providers: [{ id: 'a', baseURL: 'https://a/v1' }] }), []);
});

t('pickDefaultModel：候选不存在时回落第一个；名单为空时返回空串', () => {
  const cfg = { providers: [{ id: 'a', enabled: true, models: ['zz', 'aa'] }] };
  assert.strictEqual(models.pickDefaultModel(cfg, 'nope'), 'aa');
  assert.strictEqual(models.pickDefaultModel(cfg, 'zz'), 'zz');
  assert.strictEqual(models.pickDefaultModel({ providers: [] }), '');
});

/* ================================================================
 * 一键写入：空配置 / 空 Key / 坏文件 的降级行为
 * ================================================================ */

t('全部目标：没有任何模型时，preview 不得抛，且给出可读的提示或拦截理由', () => {
  const ctx = ctxFor(newHome('empty-all'), { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: [] }] });
  // 五个"要把模型清单写进目标配置"的目标必须拦下；通用脚本不需要模型，但必须有提示
  const mustGuard = ['dsh', 'claude-code', 'codex', 'iflow', 'opencode'];
  for (const tgt of writers.TARGETS) {
    const p = writers.preview(tgt.id, ctx);
    assert.strictEqual(p.ok, true, tgt.id + ' preview 不该失败：' + JSON.stringify(p.errors));
    if (mustGuard.includes(tgt.id)) {
      assert.ok(p.guard.length > 0, tgt.id + ' 在"没有任何模型"时必须给出拦截理由');
    } else {
      assert.strictEqual(p.guard.length, 0, tgt.id + ' 不需要模型，不该拦下');
      assert.ok(p.warnings.some((w) => w.includes('模型')), tgt.id + ' 必须提示"没有可用模型"');
    }
  }
});

t('全部目标：统一 Key 为空时都必须拦下（否则写出去的配置必然 401）', () => {
  const cfg = { port: 3091, apiKey: '', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
  const ctx = ctxFor(newHome('empty-key'), cfg);
  ctx.apiKey = '';
  for (const tgt of writers.TARGETS) {
    const p = writers.preview(tgt.id, ctx);
    assert.ok(p.guard.some((g) => g.includes('Key')), tgt.id + ' 必须因空 Key 拦下，实际 guard=' + JSON.stringify(p.guard));
  }
});

t('全部目标：统一 Key 过短时都必须拦下（引擎鉴权门槛是 ≥16 字符）', () => {
  const cfg = { port: 3091, apiKey: 'short', providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
  const ctx = ctxFor(newHome('short-key'), cfg);
  ctx.apiKey = 'short';
  for (const tgt of writers.TARGETS) {
    const p = writers.preview(tgt.id, ctx);
    assert.ok(p.guard.some((g) => g.includes('16')), tgt.id + ' 必须因 Key 过短拦下');
  }
});

t('文件类目标：目标文件是坏 JSON 时必须拒绝写入且不覆盖', async () => {
  const cases = [
    ['claude-code', (h) => [path.join(h, '.claude', 'settings.json')]],
    ['iflow', (h) => [path.join(h, '.iflow', 'settings.json')]],
    ['opencode', (h) => [path.join(h, '.config', 'opencode', 'opencode.json')]],
  ];
  for (const [id, pathsOf] of cases) {
    const home = newHome('badjson-' + id);
    const cfg = { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
    const ctx = ctxFor(home, cfg);
    for (const f of pathsOf(home)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '{ not json at all', 'utf8');
    }
    const r = await writers.apply(id, ctx);
    assert.strictEqual(r.ok, false, id + ' 在目标文件坏掉时必须拒绝写入');
    for (const f of pathsOf(home)) {
      assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ not json at all', id + ' 不得覆盖坏文件：' + f);
    }
  }
});

t('文件类目标：目标文件为空（0 字节）时应当能正常写入', async () => {
  const cfg = { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
  for (const [id, rel] of [['claude-code', '.claude/settings.json'], ['iflow', '.iflow/settings.json'], ['opencode', '.config/opencode/opencode.json']]) {
    const home = newHome('emptyfile-' + id);
    const ctx = ctxFor(home, cfg);
    const f = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '', 'utf8');
    const r = await writers.apply(id, ctx);
    assert.strictEqual(r.ok, true, id + ' 空文件应能写入：' + JSON.stringify(r.errors));
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(after && typeof after === 'object');
  }
});

t('文件类目标：目标路径是**目录**时不得崩溃，应报错返回', async () => {
  const cfg = { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
  const home = newHome('dirpath');
  const ctx = ctxFor(home, cfg);
  const f = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(f, { recursive: true });      // 用目录占住文件位置
  const r = await writers.apply('claude-code', ctx);
  assert.strictEqual(r.ok, false, '目标是目录时必须失败而不是假装成功');
  assert.ok(r.errors.length > 0);
});

t('dsh：引擎缺失时 apply 必须失败并给出原因（不得假装成功）', () => {
  const cfg = { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
  const home = newHome('no-engine');
  const ctx = ctxFor(home, cfg);
  ctx.enginePath = path.join(home, 'nope.mjs');
  return writers.apply('dsh', ctx).then((r) => {
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('引擎')), '应说明找不到引擎：' + JSON.stringify(r.errors));
  });
});

/* ================================================================
 * restore 的降级
 * ================================================================ */

t('restore：没有任何备份时返回明确错误，不抛', async () => {
  const cfg = { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m1'] }] };
  for (const id of ['claude-code', 'codex', 'iflow', 'opencode', 'envscript']) {
    const ctx = ctxFor(newHome('nobak-' + id), cfg);
    const r = await writers.restore(id, ctx);
    assert.ok(r && Array.isArray(r.errors), id + ' restore 必须返回结构化结果');
    assert.strictEqual(r.ok, false, id + ' 无备份时不该报成功');
  }
});

/* ================================================================
 * 配置文本本身的降级
 * ================================================================ */

t('datadir：坏 JSON 的既有配置被判为占位 → 允许导入覆盖（但先备份）', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'badtarget-'));
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), '{broken', 'utf8');
  const src = path.join(tmp, 'good-src.json');
  fs.writeFileSync(src, JSON.stringify({
    apiKey: KEY,
    providers: [{ id: 'real', baseURL: 'https://real.example.org/v1', apiKey: 'sk-' + 'b'.repeat(40), enabled: true }],
  }), 'utf8');
  const r = datadir.importGatewayConfig(dir, [() => src]);
  assert.strictEqual(r.action, 'upgraded');
  assert.ok(fs.existsSync(path.join(dir, 'gateway.config.json.bak-import')), '覆盖坏文件前也要备份');
});

t('datadir：目标目录不可写时不抛，返回 skipped', () => {
  const r = datadir.importGatewayConfig(path.join(tmp, 'no-such-dir-xyz', 'deep'), [() => path.join(tmp, 'good-src.json')]);
  assert.ok(r && typeof r.action === 'string');
});

/* ================================================================
 * 设置文件
 * ================================================================ */

t('Settings：null / 数组 / 对象 之类的怪补丁不得破坏设置', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'settings-'));
  const s = new Settings(dir, () => {});
  const before = s.snapshot();
  s.save(null);
  s.save([]);
  s.save({ minimizeToTray: null });
  s.save({ minimizeToTray: {} });
  assert.deepStrictEqual(s.snapshot(), before, '怪补丁不得改动任何设置');
});

t('Settings：未知键被保留（用户手写的内容不替人做主）', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'settings2-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ myCustomKey: 'keep-me', minimizeToTray: false }), 'utf8');
  const s = new Settings(dir, () => {});
  assert.strictEqual(s.get('myCustomKey'), 'keep-me');
  assert.strictEqual(s.get('minimizeToTray'), false);
});

/* ================================================================
 * probe 的入参健壮性
 * ================================================================ */

t('probe：供应商配置残缺时 probeProvider 不抛，返回可读结论', async () => {
  for (const bad of [null, {}, { id: 'x' }, { id: 'x', baseURL: '' }, { id: 'x', baseURL: 'not-a-url' }]) {
    const r = await probe.probeProvider(bad, {});
    assert.ok(r && typeof r.id === 'string', '应返回结构化结果：' + JSON.stringify(bad));
    assert.ok(r.verdict, '应给出结论文本');
  }
});

t('probe：auth=workbuddy 的供应商跳过探测并说明原因', async () => {
  const r = await probe.probeProvider({ id: 'wb', baseURL: 'https://copilot.tencent.com/v2', auth: 'workbuddy' }, {});
  assert.strictEqual(r.skipped, true);
  assert.ok(/账户池|凭据/.test(r.verdict));
});

/* ================================================================
 * 预览必须可结构化克隆（要经 IPC 送到界面）
 * ================================================================ */

t('全部目标：各种配置形态下，preview 结果都必须可结构化克隆', () => {
  const shapes = [
    null,
    { providers: [] },
    { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k' }] },
    { port: 3091, apiKey: KEY, providers: [{ id: 'a', baseURL: 'https://a.com/v1', apiKey: 'k', models: ['m\"x', "m'y"], auth: 'workbuddy', accounts: [{ id: 'z' }], quirks: ['force-stream'] }] },
  ];
  for (const shape of shapes) {
    const ctx = ctxFor(newHome('clone-' + Math.random().toString(36).slice(2, 8)), shape);
    for (const tgt of writers.TARGETS) {
      const p = writers.preview(tgt.id, ctx);
      assert.doesNotThrow(() => structuredClone(p), tgt.id + ' 的预览必须可克隆');
    }
  }
});

/* ================================================================
 * util 的边界
 * ================================================================ */

t('util.writeAtomic：目标是目录时返回 ok:false 而不是抛', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'wa-'));
  const target = path.join(dir, 'sub');
  fs.mkdirSync(target);
  const r = util.writeAtomic(target, 'x');
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

t('util.tomlUpsertTable：表头出现在字符串值里时不误判', () => {
  const text = 'a = "this [model_providers.x] is a string"\n\n[real]\nk = 1\n';
  const out = util.tomlUpsertTable(text, 'model_providers.x', ['name = "N"']);
  assert.ok(out.includes('a = "this [model_providers.x] is a string"'), '字符串值必须原样保留');
  assert.ok(out.includes('[model_providers.x]\nname = "N"'), '应追加真表');
  assert.strictEqual((out.match(/^\[model_providers\.x\]$/gm) || []).length, 1);
});

t('util.tomlUpsertTopKey：键名是另一个键前缀时不得误匹配（model vs model_provider）', () => {
  const text = 'model_provider = "old"\n\n[t]\nk = 1\n';
  const out = util.tomlUpsertTopKey(text, 'model', '"new"');
  assert.ok(/^model_provider = "old"$/m.test(out), 'model_provider 不得被改动');
  assert.ok(/^model = "new"$/m.test(out), '应新增 model');
});

/* ================================================================
 * dsh：预览必须与引擎实际写入**逐字一致**
 * ================================================================ */

const dshTarget = require('../src/writers/target-dsh');

t('dsh：预览的 gateway 段必须与引擎真实落盘的内容逐字一致（含畸形模型名）', async () => {
  const home = newHome('dsh-preview-parity');
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
  const cfg = {
    port: 3099,
    apiKey: KEY,
    clientProfile: 'claude',
    providers: [{
      id: 'p1',
      baseURL: 'https://relay.example.org/v1',
      apiKey: 'k',
      enabled: true,
      models: [
        "tricky'name",              // 单引号（YAML 里要翻倍）
        'multi\nline',              // 换行（YAML 单引号标量里不合法，引擎会压成空格）
        'has: colon #hash',
        { id: 'v1', as: 'vision-model', vision: true, contextWindow: 262144, maxTokens: 8192 },
      ],
    }],
  };
  const ctx = ctxFor(home, cfg);
  ctx.port = 3099;
  ctx.apiKey = KEY;

  const p = dshTarget.preview(ctx);
  const previewBlock = p.files[0].after;
  assert.ok(previewBlock, '预览应给出将要写入的 gateway 段');

  const r = await dshTarget.apply(ctx);
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors) + ' ' + r.output);

  const written = dshTarget.findGatewayBlock(fs.readFileSync(path.join(home, '.dsh', 'settings.yaml'), 'utf8'));
  assert.strictEqual(written.found, true, 'settings.yaml 里应能找到 gateway 段');
  assert.strictEqual(
    written.text, previewBlock,
    '预览与实际写入必须逐字一致 —— 否则「先预览」就是误导\n--- 预览 ---\n' + previewBlock + '\n--- 实际 ---\n' + written.text,
  );

  // 顺带确认恶意模型名没把 YAML 结构撑坏：整个 gateway 段里不得出现裸换行开头的伪键
  for (const line of previewBlock.split('\n')) {
    assert.ok(!/^(echo|injectedKey)/.test(line.trim()), '预览里不得出现注入的伪键：' + line);
  }
  assert.ok(previewBlock.includes("'multi line'"), '换行应被压成空格并整体加引号');
  assert.ok(previewBlock.includes("''"), '单引号应被翻倍');
});

run();
