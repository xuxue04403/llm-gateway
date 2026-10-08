/* dashboard.js — 概览页：状态、接入信息、账户池健康 */
'use strict';

LG.renders.dashboard = function renderDashboard() {
  const st = LG.state;
  if (!st) return;
  const running = st.gateway.running;
  const ready = running && !!st.gateway.ready;   // 端口真的在监听才算"运行中"
  const port = st.gateway.port;

  /* --- 状态卡 --- */
  $('#dashDot').className = 'dot lg ' + (ready ? 'on' : (running ? 'warn' : 'off'));
  $('#dashStatus').textContent = ready ? '运行中' : (running ? '启动中…' : '已停止');
  $('#dashHint').textContent = running
    ? ('端口 ' + port + ' · 配置 ' + st.gateway.configPath)
    : '点右上角「启动」拉起网关';

  /* --- 统计卡 --- */
  const all = (LG.config && LG.config.providers) || [];
  const on = all.filter((p) => p.enabled !== false);
  $('#dashProviders').textContent = String(on.length);
  $('#dashModels').textContent = String(modelNames().length);
  $('#dashProvidersSub').textContent = all.length === on.length
    ? `共 ${all.length} 家，全部启用`
    : `共 ${all.length} 家，其中 ${all.length - on.length} 家已停用`;

  /* --- 账户池 --- */
  const accts = (LG.health && Array.isArray(LG.health.accounts)) ? LG.health.accounts : null;
  if (!running) {
    $('#dashAccounts').textContent = '—';
    $('#dashProxy').textContent = '网关未运行';
  } else if (!accts) {
    $('#dashAccounts').textContent = '—';
    $('#dashProxy').textContent = '正在读取 /health…';
  } else {
    const cool = accts.filter(isCooling).length;
    if (accts.length === 0) {
      $('#dashAccounts').innerHTML = '无 <span class="hint">（没有使用账户池的供应商）</span>';
    } else {
      $('#dashAccounts').innerHTML = `${accts.length - cool} / ${accts.length}`
        + (cool > 0 ? ` <span class="tag warn">${cool} 个冷却中</span>` : ' <span class="tag ok">全部可用</span>');
    }
    const px = (LG.health && LG.health.proxy) || {};
    $('#dashProxy').textContent = px.url
      ? ('代理 ' + px.url + (px.noProxy ? ' · ' + px.noProxy.split(',').length + ' 个域名直连' : ''))
      : '直连（未注入代理）';
  }

  /* --- 接入信息 --- */
  // Key 取**工作副本**而不是磁盘上的快照：点「重新生成统一 Key」只改工作副本，
  // 若这里读磁盘值，卡片会继续显示并允许复制那个即将失效的旧 Key（实测踩到）。
  // 有未保存改动时标明，避免用户以为已经生效。
  const key = String((LG.config && LG.config.apiKey) || '');
  const keyLabel = LG.dirty ? '统一 API Key（未保存）' : '统一 API Key';
  const rows = [
    ['OpenAI 兼容 Base URL', baseUrlOf(port, true), '客户端里选 "OpenAI Compatible"'],
    ['Anthropic 兼容 Base URL', baseUrlOf(port, false), '客户端里选 "Anthropic"；注意不带 /v1'],
    [keyLabel, key || '(未设置)', '点一下即复制'],
    ['模型列表', baseUrlOf(port, true) + '/models', 'GET，需要带上面的 Key'],
    ['健康检查', 'http://127.0.0.1:' + port + '/health', '不需要 Key'],
  ];
  $('#dashEndpoints').innerHTML = rows.map(([k, v, note]) => `
    <div class="kv" data-copy="${attr(v)}" title="${attr(note)}">
      <span class="k">${esc(k)}</span>
      <span class="v">${esc(v || '(空)')}</span>
      <span class="copy">复制</span>
    </div>`).join('');
  $$('#dashEndpoints .kv').forEach((n) => {
    n.addEventListener('click', () => copy(n.dataset.copy));
  });

  renderHealth();
};

/**
 * /health 的账户条目形状（引擎 accountPoolSnapshot 的实际输出，别照猜）：
 *   账户级：{ key, provider, id, state, remainMs, reason?, lastUsed?, orphan? }
 *   模型级：{ key, provider, model, state, remainMs, reason, modelScoped: true }
 * state ∈ 'ok' | 'rate' | 'credit' | 'session'；**没有 cooling 字段**——
 * "在冷却"就是 state !== 'ok'。
 */
function isCooling(a) { return !!a && a.state && a.state !== 'ok'; }

function renderHealth() {
  const box = $('#healthBox');
  if (!LG.state || !LG.state.gateway.running) {
    box.innerHTML = '<div class="empty">网关未运行，暂无数据。</div>';
    return;
  }
  const h = LG.health;
  if (!h) { box.innerHTML = '<div class="empty">正在读取 /health…</div>'; return; }
  if (!h.ok && !Array.isArray(h.accounts)) {
    box.innerHTML = `<div class="empty">读取失败：${esc(h.error || '未知错误')}</div>`;
    return;
  }
  const accts = Array.isArray(h.accounts) ? h.accounts : [];
  if (accts.length === 0) {
    box.innerHTML = '<div class="empty">没有使用账户池的供应商（单一 apiKey 的供应商不产生账户条目）。</div>';
    return;
  }
  const rows = accts.map((a) => {
    const cooling = isCooling(a);
    const kind = COOL_KIND[a.state] || { text: a.state || '冷却', cls: 'warn' };
    const state = cooling
      ? `<span class="tag ${kind.cls}">${esc(kind.text)}</span>`
      : '<span class="tag ok">可用</span>';
    const remain = cooling ? `<span class="mono">剩 ${esc(fmtRemain(Date.now() + Number(a.remainMs || 0)))}</span>` : '';
    const scope = a.modelScoped
      ? `<span class="tag sm purple">模型级 · ${esc(a.model || '')}</span>`
      : '<span class="tag sm">账户级</span>';
    const flags = []
      .concat(a.lastUsed ? ['<span class="tag sm info">最近使用</span>'] : [])
      .concat(a.orphan ? ['<span class="tag sm warn">配置已移除</span>'] : [])
      .join(' ');
    const detail = a.reason ? `<span class="hint">${esc(String(a.reason).slice(0, 100))}</span>` : '';
    return `<tr>
      <td><span class="mono">${esc(a.provider || (a.key || '').split('#')[0])}</span></td>
      <td><span class="mono">${esc(a.id || (a.key || '').split('#')[1] || '—')}</span></td>
      <td>${state} ${flags}</td>
      <td>${scope}</td>
      <td>${remain}</td>
      <td>${detail}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="table-wrap"><table class="tbl">
    <thead><tr><th>供应商</th><th>账户</th><th>状态</th><th>冷却粒度</th><th>剩余</th><th>细节</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

async function refreshHealth() {
  if (!LG.state || !LG.state.gateway.running) { LG.health = null; renderHealth(); return; }
  try {
    LG.health = await window.lgw.gwHealth();
  } catch (_) {
    LG.health = { ok: false, error: 'IPC 失败' };
  }
  // 只重绘，不在这里另写 #dashAccounts —— 同一元素被两处写会造成
  // "统计卡显示『无』而副标题显示『正在读取』"这种自相矛盾的画面（实测踩到）。
  if (LG.activeView === 'dashboard') LG.renders.dashboard();
  else renderHealth();
}

LG.dashboard = { refreshHealth };

/* 概览页的按钮接线（在 app.js 里统一调 init） */
LG.initDashboard = function initDashboard() {
  $('#btnRefreshHealth').addEventListener('click', () => { refreshHealth(); toast('已刷新', 'ok', 1200); });
  $('#btnOpenData').addEventListener('click', () => {
    if (LG.state) window.lgw.openPath(LG.state.dataDir);
  });
  $('#btnCopyAll').addEventListener('click', () => {
    const st = LG.state;
    if (!st) return;
    const t = [
      'LLM Gateway 接入信息',
      'OpenAI 兼容 Base URL : ' + baseUrlOf(st.gateway.port, true),
      'Anthropic 兼容 Base URL : ' + baseUrlOf(st.gateway.port, false),
      '统一 API Key : ' + String((LG.config && LG.config.apiKey) || ''),
      '模型 : ' + modelNames().join(', '),
    ].join('\n');
    copy(t);
  });
  $('#btnRegenKey').addEventListener('click', async () => {
    // 失败必须说出来。旧实现 `if (!r || !r.ok) return;` 是**静默返回** ——
    // 而 `{ok:false, error}` 正是主进程 IPC 兜底包装的标准失败形态，
    // 于是"写盘失败"在界面上表现为"点了没反应"，用户分不清是没点到还是真失败了。
    let r = null;
    try {
      r = await window.lgw.cfgGenerateKey();
    } catch (e) {
      toast('生成失败：' + ((e && e.message) || e), 'err', 8000);
      return;
    }
    if (!r || !r.ok) { toast('生成失败：' + ((r && r.error) || '未知错误'), 'err', 8000); return; }
    if (typeof r.key !== 'string' || !r.key) { toast('生成失败：返回的 Key 无效', 'err', 8000); return; }
    Modal.open({
      title: '重新生成统一 Key',
      body: `<p>新 Key：</p><div class="diffbox"><div class="l add">${esc(r.key)}</div></div>
        <div class="warnbox">旧 Key 立刻失效。所有已经写入过的客户端都要重新跑一次「客户端接入」，否则会 401。</div>`,
      buttons: [
        { label: '取消', cls: 'btn-ghost' },
        {
          label: '确认替换',
          cls: 'btn-primary',
          onClick: () => {
            LG.config.apiKey = r.key;
            markDirty('统一 Key 已更换');
            LG.renders.dashboard();
            toast('已写入工作副本，记得点「保存并生效」', 'warn', 5000);
          },
        },
      ],
    });
  });
};
