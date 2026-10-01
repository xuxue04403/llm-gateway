// writers/models.js — 从网关配置推导"给客户端看的模型清单"
//
// ⚠ 这里的规则必须与引擎 src/gateway/model-gateway.mjs 的 modelEntries / logicalModelNames /
// logicalModelSupportsVision **完全一致**，否则会出现"一键写入的模型列表"与"网关实际能路由的
// 模型"对不上（客户端选了一个网关不认的名字 → 404）。测试 tests/writers.test.js 里有一条
// 断言专门比对：本模块算出的清单 == 引擎 `--write-dsh` 真实写进 dsh 的清单。
//
// 关于"为什么在应用侧重写一遍而不是让引擎导出"：引擎是一份**与原版字节级一致**的副本
// （见 scripts/check-engine-parity.mjs），改它的导出会破坏这个可验证性。这段纯函数只有
// 几十行，且被回归测试锁死与引擎输出一致，代价远小于破坏"零差异"。
'use strict';

/** 单个供应商声明的模型条目 → [{ up, as, vision?, contextWindow?, maxTokens? }] */
function modelEntries(provider) {
  const out = [];
  const list = provider && Array.isArray(provider.models) ? provider.models : [];
  for (const m of list) {
    if (typeof m === 'string') {
      const s = m.trim();
      if (s) out.push({ up: s, as: s });
      continue;
    }
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      const up = String(m.id ?? m.up ?? m.upstream ?? m.model ?? '').trim();
      if (!up) continue;
      const as = String(m.as ?? m.alias ?? m.model ?? m.name ?? up).trim();
      const vision = m.vision === true
        || (Array.isArray(m.input) && m.input.map((x) => String(x).toLowerCase()).includes('image'));
      const entry = { up, as: as || up };
      if (vision) entry.vision = true;
      const ctxWin = Number(m.contextWindow ?? m.context ?? m.ctx);
      const maxTok = Number(m.maxTokens ?? m.maxOutputTokens ?? m.max_output_tokens);
      if (Number.isFinite(ctxWin) && ctxWin > 0) entry.contextWindow = ctxWin;
      if (Number.isFinite(maxTok) && maxTok > 0) entry.maxTokens = maxTok;
      // 逐模型超时（2026-09-30 新增）：必须与引擎侧一致地透出，
      // 否则一键写入 dsh/客户端配置时会把用户精心设的逐模型超时丢掉。
      const tmo = Number(m.timeoutMs);
      if (Number.isFinite(tmo) && tmo > 0) entry.timeoutMs = tmo;
      out.push(entry);
    }
  }
  return out;
}

/** 该供应商声明的逻辑模型名（去重，保序） */
function logicalModelNames(provider) {
  const seen = new Set();
  const out = [];
  for (const e of modelEntries(provider)) {
    if (!seen.has(e.as)) { seen.add(e.as); out.push(e.as); }
  }
  return out;
}

function providerSupportsVision(provider, logical) {
  return modelEntries(provider).some((e) => e.as === logical && e.vision === true);
}

function logicalModelSupportsVision(cfg, logical) {
  return ((cfg && cfg.providers) || []).some((p) => p && p.enabled !== false && providerSupportsVision(p, logical));
}

/**
 * 汇总全部**启用**供应商的逻辑模型，附能力信息。
 *
 * @returns {Array<{id:string, vision:boolean, contextWindow:number|null, maxTokens:number|null,
 *                  providers:string[], upstreamIds:string[]}>}
 */
function collectModels(cfg) {
  const map = new Map();
  for (const p of ((cfg && cfg.providers) || [])) {
    if (!p || p.enabled === false) continue;
    const pid = String(p.id || '?');
    for (const e of modelEntries(p)) {
      let rec = map.get(e.as);
      if (!rec) {
        rec = { id: e.as, vision: false, contextWindow: null, maxTokens: null, providers: [], upstreamIds: [] };
        map.set(e.as, rec);
      }
      if (!rec.providers.includes(pid)) rec.providers.push(pid);
      if (!rec.upstreamIds.includes(e.up)) rec.upstreamIds.push(e.up);
      if (e.vision === true) rec.vision = true;
      // 上下文/输出取**所有家里的最小值**（保守：任一家装不下就按装不下的算）。
      // 与引擎 writeDshConfig 的 modelLimits 同规则；都没有时留 null 由调用方给默认。
      if (e.contextWindow) rec.contextWindow = rec.contextWindow ? Math.min(rec.contextWindow, e.contextWindow) : e.contextWindow;
      if (e.maxTokens) rec.maxTokens = rec.maxTokens ? Math.min(rec.maxTokens, e.maxTokens) : e.maxTokens;
    }
  }
  return [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true, sensitivity: 'base' }));
}

/** 逻辑模型名数组（已排序）——与引擎写入 dsh 的顺序规则一致（localeCompare numeric/base）。 */
function collectModelNames(cfg) {
  return collectModels(cfg).map((m) => m.id);
}

/**
 * 挑一个"适合当客户端默认模型"的名字。
 * 优先取候选名单里出现的（例如用户上次选的），否则取视觉能力更强的第一个，
 * 都没有就取排序后的第一个。
 */
function pickDefaultModel(cfg, preferred) {
  const names = collectModelNames(cfg);
  if (names.length === 0) return '';
  if (preferred && names.includes(preferred)) return preferred;
  return names[0];
}

/**
 * 界面传下来的"已选模型"是否还在清单里。
 *
 * 为什么要查：界面上的选择是**有状态**的（`LG.clientOptions[id].model`）。用户先选好模型、
 * 回头把那个模型在供应商里改名或删掉、保存，再点写入 —— 选项里仍是旧名字。
 * 旧实现只在 `undefined` 时播种，写入器的 guard 也只查"有没有模型"，于是会把一个网关
 * 根本不认识的模型名写进客户端配置（客户端随后必然 404）。实测确认过这条路径。
 *
 * @returns {string} 有问题时返回给人看的说明，否则空串
 */
function chosenModelProblem(cfg, chosen) {
  const m = String(chosen || '').trim();
  if (!m) return '';
  const names = collectModelNames(cfg);
  if (names.length === 0) return '';        // "一个模型都没有"由调用方单独说明
  if (!names.includes(m)) {
    return `选择的模型「${m}」已不在网关的模型清单里（可能被改名或删除了）—— 请在「客户端接入」里重新选择`;
  }
  return '';
}

module.exports = {
  modelEntries,
  logicalModelNames,
  providerSupportsVision,
  logicalModelSupportsVision,
  collectModels,
  collectModelNames,
  pickDefaultModel,
  chosenModelProblem,
};
