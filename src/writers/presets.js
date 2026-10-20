'use strict';
/**
 * 供应商**预设目录**（2026-10-20）。
 *
 * 数据来自 `src/gateway/provider-presets.json` —— 由 mu-zi-lee/magpie-our-free-model（MIT）
 * 的 `vendor/ofm/src/providers/registry.json` 归一化而来（75 家 / 504 个模型）。
 *
 * 这里只做**纯逻辑**（不碰磁盘），便于单测：
 *   · `loadPresets()`  读目录
 *   · `applyPresets()` 把若干个预设**合并进一份 config 对象**（不改原对象）
 *
 * 与 CLI（scripts/presets.mjs）的分工：CLI 负责读写文件、备份、打印。
 *
 * ⚠ 三条硬规则：
 *   ① **绝不写入密钥**。预设里只有 `apiKeyEnv`（变量名提示），实际 Key 由用户填或环境变量提供。
 *   ② 新增的供应商默认 `enabled: false` —— 没有 Key 的家挂上去只会白占候选位、拉长 failover。
 *   ③ `manualOnly`（oauth/adc/本地服务）直接跳过并说明原因，不硬塞进「baseURL + apiKey」模型。
 */
const fs = require('fs');
const path = require('path');

const PRESET_FILE = path.join(__dirname, '..', 'gateway', 'provider-presets.json');

/** 读预设目录。 */
function loadPresets(file) {
  const p = file || PRESET_FILE;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const presets = Array.isArray(raw.presets) ? raw.presets : [];
  return { presets, skipped: raw.skipped || [], count: presets.length, readme: raw._readme || '' };
}

/**
 * 把一个预设转成 config.providers 里的条目。
 * @param {object} preset
 * @param {{apiKey?: string, enabled?: boolean, priority?: number, asOverrides?: object}} opts
 */
function presetToProvider(preset, opts) {
  const o = opts || {};
  const nameOf = (m) => (typeof m === 'string' ? m : String((m && (m.as || m.id)) || ''));
  // 模型的 as 默认 = id 去掉 -free 后缀（与引擎的 -free 自动归一一致，保持两处语义相同）
  const models = (preset.models || []).map((m) => {
    const id = String(m.id || '').trim();
    if (!id) return null;
    const entry = { id };
    const as = String((o.asOverrides && o.asOverrides[id]) || m.as || '').trim() || id.replace(/-free$/i, '');
    if (as !== id) entry.as = as;
    if (m.vision === true) entry.vision = true;
    if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) entry.contextWindow = m.contextWindow;
    if (Number.isFinite(m.maxTokens) && m.maxTokens > 0) entry.maxTokens = m.maxTokens;
    return entry;
  }).filter(Boolean);

  const provider = {
    id: preset.id,
    name: preset.name || preset.id,
    baseURL: preset.baseURL,
    protocol: preset.protocol,
    // 密钥只从调用方（CLI 参数或环境变量）来，预设本身永远为空
    apiKey: o.apiKey || '',
    models,
    // 默认关闭：没 Key 的家参与 failover 只会白等
    enabled: o.enabled === true,
    priority: Number.isFinite(o.priority) ? o.priority : 5,
  };
  if (preset.quirks && preset.quirks.length) provider.quirks = preset.quirks.slice();
  return provider;
}

/**
 * 把若干预设合并进 config（**不改原对象**）。
 *
 * @param {object} cfg 现有配置
 * @param {string[]} ids 要添加的预设 id
 * @param {{keys?: Object<string,string>, enabled?: boolean, priority?: number, onlyFree?: boolean, file?: string}} opts
 * @returns {{cfg:object, added:Array, skipped:Array}}
 */
function applyPresets(cfg, ids, opts) {
  const o = opts || {};
  const { presets } = loadPresets(o.file);
  const byId = new Map(presets.map((p) => [p.id, p]));
  const next = JSON.parse(JSON.stringify(cfg));
  if (!Array.isArray(next.providers)) next.providers = [];
  const existing = new Set(next.providers.map((p) => p.id));

  const added = [];
  const skipped = [];
  for (const id of ids) {
    const preset = byId.get(id);
    if (!preset) { skipped.push({ id, why: '预设目录里没有这个 id' }); continue; }
    if (existing.has(id)) { skipped.push({ id, why: '配置里已存在同名供应商' }); continue; }
    if (preset.manualOnly) {
      skipped.push({ id, why: '需要手工配置（oauth / adc / 本地服务），无法用 baseURL+apiKey 表达' });
      continue;
    }
    if (o.onlyFree && preset.freeTier !== true) { skipped.push({ id, why: '不是免费档（本次只要免费档）' }); continue; }
    if (!preset.models || !preset.models.length) {
      skipped.push({ id, why: '预设没有模型清单（本地服务需自己填模型）' });
      continue;
    }
    const key = (o.keys && o.keys[id]) || '';
    const provider = presetToProvider(preset, { apiKey: key, enabled: o.enabled, priority: o.priority });
    next.providers.push(provider);
    existing.add(id);
    added.push({ id, models: provider.models.length, hasKey: !!key, freeTier: preset.freeTier === true });
  }
  return { cfg: next, added, skipped };
}

/** 列出预设（CLI 展示用）。 */
function listPresets(opts) {
  const o = opts || {};
  const { presets } = loadPresets(o.file);
  return presets
    .filter((p) => (o.onlyFree ? p.freeTier === true : true))
    .filter((p) => (o.includeManual === false ? !p.manualOnly : true))
    .map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      models: (p.models || []).length,
      freeTier: p.freeTier === true,
      manualOnly: p.manualOnly === true,
      apiKeyEnv: p.apiKeyEnv || null,
      baseURL: p.baseURL,
    }));
}

module.exports = { loadPresets, listPresets, presetToProvider, applyPresets, PRESET_FILE };
