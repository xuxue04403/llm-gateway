/* models.js — 模型总览页 */
'use strict';

/**
 * 复制图标（Feather 的 copy：两个叠放的圆角矩形）。
 * 用描边而非填充，与界面里其它图标（导航栏那套）观感一致。
 */
const MD_COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

LG.renders.models = function renderModels() {
  if (!LG.config) return;
  const q = String(($('#mdSearch') || {}).value || '').trim().toLowerCase();
  const onlyVision = $('#mdOnlyVision') && $('#mdOnlyVision').checked;
  let list = collectModels();
  if (q) list = list.filter((m) => m.id.toLowerCase().includes(q) || m.providers.join(' ').toLowerCase().includes(q));
  if (onlyVision) list = list.filter((m) => m.vision);

  const all = collectModels();
  $('#modelEmpty').classList.toggle('hidden', all.length > 0);

  const tb = $('#modelTable tbody');
  tb.innerHTML = list.map((m) => {
    const single = m.providers.length === 1;
    // 提供方按**路由优先级**排列（见 core.js 的 collectModels）——顺序就是网关的尝试顺序。
    // ⚠ 但要说清楚"同级会轮转"：引擎在同一优先级层内用 round-robin 换起始点，
    // 所以同优先级的几家谁先被试是不确定的。不写这一句的话，用户看到固定顺序
    // 会以为"写在前面的永远先试"，而实际不是。
    const tiers = {};
    (m.providerPriority || []).forEach((n) => { tiers[n] = (tiers[n] || 0) + 1; });
    const tags = m.providers.map((p, i) => {
      const n = (m.providerPriority || [])[i];
      const share = n !== undefined && tiers[n] > 1;
      const tip = n === undefined ? '' :
        `优先级 ${n}（数字小的先试）` + (share ? `；同级共 ${tiers[n]} 家，层内按轮转决定先后` : '');
      return `<span class="tag sm${i === 0 && !share ? ' lead' : ''}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(p)}</span>`;
    }).join(' ');
    // 模型名旁的复制按钮。
    // 放在**名称正后方**（而不是行尾）：它是"复制这个模型名"的动作，
    // 贴着名字才不会看错行 —— 这一列里 `单点` 之类的标签会随模型变化，
    // 若按钮固定右对齐，用户很难确认自己复制的是哪一行。
    return `<tr>
      <td><span class="mono">${esc(m.id)}</span><button class="copy-btn" data-copy="${attr(m.id)}" title="复制模型名" aria-label="复制模型名">${MD_COPY_ICON}</button>${single ? ' <span class="tag sm warn" title="只有一家提供，这家挂了该模型就不可用">单点</span>' : ''}</td>
      <td>${tags}</td>
      <td>${m.vision ? '<span class="tag sm ok">支持</span>' : '<span class="hint">—</span>'}</td>
      <td>${esc(fmtNum(m.contextWindow))}</td>
      <td>${esc(fmtNum(m.maxTokens))}</td>
    </tr>`;
  }).join('');

  if (all.length > 0 && list.length === 0) {
    tb.innerHTML = '<tr><td colspan="5" class="hint" style="padding:18px;text-align:center;">没有匹配的模型</td></tr>';
  }

  // 每次渲染后重新绑定：搜索/筛选会整表重建 innerHTML，旧监听器随之失效。
  // 用 `$$` 逐个绑（表格最多几十行，开销可忽略）。
  $$('#modelTable .copy-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();          // 别触发行级 hover/未来可能加的行点击
      copy(b.dataset.copy);
    });
  });
};

LG.initModels = function initModels() {
  $('#mdSearch').addEventListener('input', () => LG.renders.models());
  $('#mdOnlyVision').addEventListener('change', () => LG.renders.models());
};
