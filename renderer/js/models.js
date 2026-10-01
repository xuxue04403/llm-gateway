/* models.js — 模型总览页 */
'use strict';

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
    return `<tr>
      <td><span class="mono">${esc(m.id)}</span>${single ? ' <span class="tag sm warn" title="只有一家提供，这家挂了该模型就不可用">单点</span>' : ''}</td>
      <td>${m.providers.map((p) => `<span class="tag sm">${esc(p)}</span>`).join(' ')}</td>
      <td>${m.vision ? '<span class="tag sm ok">支持</span>' : '<span class="hint">—</span>'}</td>
      <td>${esc(fmtNum(m.contextWindow))}</td>
      <td>${esc(fmtNum(m.maxTokens))}</td>
    </tr>`;
  }).join('');

  if (all.length > 0 && list.length === 0) {
    tb.innerHTML = '<tr><td colspan="5" class="hint" style="padding:18px;text-align:center;">没有匹配的模型</td></tr>';
  }
};

LG.initModels = function initModels() {
  $('#mdSearch').addEventListener('input', () => LG.renders.models());
  $('#mdOnlyVision').addEventListener('change', () => LG.renders.models());
};
