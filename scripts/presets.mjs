#!/usr/bin/env node
/**
 * 供应商预设 CLI（2026-10-20）
 *
 * 数据来自 mu-zi-lee/magpie-our-free-model（MIT）的渠道清单，归一化后随本项目分发
 * （见 src/gateway/provider-presets.json / src/writers/presets.js 的说明）。
 *
 * 用法：
 *   node scripts/presets.mjs --list                 # 列出全部预设
 *   node scripts/presets.mjs --list --free          # 只看免费档
 *   node scripts/presets.mjs --add kilo,gemini      # 添加指定预设（默认 enabled:false）
 *   node scripts/presets.mjs --add-free             # 添加全部免费档（同样默认关闭）
 *   node scripts/presets.mjs --add kilo --key kilo=sk-xxx --enable
 *
 * 选项：
 *   --config <path>   目标配置（默认 out/LLM-Gateway/data/gateway.config.json）
 *   --key id=value    给某个预设填 apiKey（可重复）；未给则从 apiKeyEnv 环境变量取
 *   --enable          新增的家直接启用（默认关闭，因为没 Key 只会白占候选位）
 *   --priority <n>    新增家的优先级（默认 5，即排在现有家之后）
 *   --dry-run         只打印将要做什么，不写文件
 *
 * ⚠ 写文件前一律**先备份**（同目录 gateway.config.pre-presets-<ts>.json）。
 * ⚠ 预设里**不含任何密钥**；本命令也只在显式 `--key` 或环境变量存在时写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadPresets, listPresets, applyPresets } = require('../src/writers/presets.js');

const argv = process.argv.slice(2);
const getFlag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
};
const has = (name) => argv.includes(name);
const multi = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
};

const DEFAULT_CFG = path.join(process.cwd(), 'out', 'LLM-Gateway', 'data', 'gateway.config.json');
const cfgPath = String(getFlag('--config') || DEFAULT_CFG);

function die(msg) { console.error('  ✗ ' + msg); process.exit(1); }

// ── --list ──
if (has('--list')) {
  const rows = listPresets({ onlyFree: has('--free') });
  console.log('  预设总数 = ' + rows.length + (has('--free') ? '（仅免费档）' : '') + '\n');
  console.log('  ' + 'id'.padEnd(18) + '协议'.padEnd(20) + '模型'.padStart(4) + '  标记 / Key 变量');
  for (const r of rows) {
    const flags = [];
    if (r.freeTier) flags.push('免费档');
    if (r.manualOnly) flags.push('需手工');
    console.log('  ' + String(r.id).padEnd(18) + String(r.protocol).padEnd(20)
      + String(r.models).padStart(4) + '  ' + (flags.join('/') || '-')
      + (r.apiKeyEnv ? '  ' + r.apiKeyEnv : ''));
  }
  process.exit(0);
}

// ── --add / --add-free ──
const addFree = has('--add-free');
const addArg = getFlag('--add');
const ids = [];
if (addFree) {
  for (const r of listPresets({ onlyFree: true })) ids.push(r.id);
} else if (typeof addArg === 'string') {
  for (const s of addArg.split(',')) { const t = s.trim(); if (t) ids.push(t); }
} else if (addArg === true) {
  die('--add 需要一个 id 列表，例如 --add kilo,gemini');
}
if (!ids.length) {
  console.log('  用法：\n'
    + '    node scripts/presets.mjs --list [--free]\n'
    + '    node scripts/presets.mjs --add <id[,id...]> [--key id=value] [--enable] [--priority n] [--dry-run]\n'
    + '    node scripts/presets.mjs --add-free [--enable] [--dry-run]');
  process.exit(0);
}

if (!fs.existsSync(cfgPath)) die('找不到配置文件：' + cfgPath);
const cfgText = fs.readFileSync(cfgPath, 'utf8');
let cfg;
try { cfg = JSON.parse(cfgText); } catch (e) { die('配置文件不是合法 JSON：' + (e && e.message)); }

// 收集 Key：--key id=value 优先，其次 apiKeyEnv 环境变量
const keys = {};
for (const kv of multi('--key')) {
  const i = kv.indexOf('=');
  if (i <= 0) die('--key 需要 id=value 形式，收到：' + kv);
  keys[kv.slice(0, i)] = kv.slice(i + 1);
}
const { presets } = loadPresets();
for (const id of ids) {
  if (keys[id]) continue;
  const preset = presets.find((p) => p.id === id);
  if (preset && preset.apiKeyEnv && process.env[preset.apiKeyEnv]) keys[id] = process.env[preset.apiKeyEnv];
}

const pr = Number(getFlag('--priority'));
const result = applyPresets(cfg, ids, {
  keys,
  enabled: has('--enable'),
  priority: Number.isFinite(pr) && pr > 0 ? pr : 5,
});

console.log('  目标配置 = ' + cfgPath);
console.log('  新增 ' + result.added.length + ' 家：');
for (const a of result.added) {
  console.log('    + ' + a.id.padEnd(18) + a.models + ' 个模型'
    + (a.freeTier ? '  免费档' : '')
    + (a.hasKey ? '  已带 Key' : '  ⚠ 无 Key'));
}
if (result.skipped.length) {
  console.log('  跳过 ' + result.skipped.length + ' 个：');
  for (const s of result.skipped) console.log('    - ' + s.id.padEnd(18) + s.why);
}
if (!result.added.length) { console.log('\n  没有可添加的条目，未写文件。'); process.exit(0); }

if (has('--dry-run')) { console.log('\n  --dry-run：未写文件。'); process.exit(0); }

const bak = cfgPath.replace(/\.json$/, '.pre-presets-' + Date.now() + '.json');
fs.copyFileSync(cfgPath, bak);
fs.writeFileSync(cfgPath, JSON.stringify(result.cfg, null, 2) + '\n', 'utf8');
console.log('\n  已备份 → ' + path.basename(bak));
console.log('  已写入 ' + path.basename(cfgPath) + '（供应商总数 ' + cfg.providers.length + ' → ' + result.cfg.providers.length + '）');
console.log('  提示：新增的家默认 enabled=false；填好 apiKey 后到 GUI 里逐个启用，或加 --enable 重跑。');
