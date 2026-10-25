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
    const pn = (LG.health && LG.health.proxyNote) || {};
    // 规则 1：运行期因"代理不可用但直连可达"被切成直连的 host —— 也要说出来，
    // 否则用户只会看到"某几家明明配了代理却不走代理"，无从判断是引擎自动降级还是配置错了。
    const rt = Array.isArray(px.runtimeDirect) ? px.runtimeDirect : [];
    const proxyText = px.url
      ? ('代理 ' + px.url + (px.noProxy ? ' · ' + px.noProxy.split(',').length + ' 个域名直连' : ''))
      : '直连（未注入代理）';
    // 配置里写的代理连不上时**必须让用户看见**：那种情况下所有未标直连的供应商请求都会失败，
    // 而这一页原本显示一切正常（用户实测就是这么被误导的）。主进程的决策见 gateway-manager.proxyNote()。
    if (pn.warn || rt.length) {
      const head = pn.warn
        ? esc(proxyText) + ' <span class="tag warn">配置的代理 ' + esc(pn.configured || '')
          + ' 连不上，已' + (pn.used ? '改用 ' + esc(pn.used) : '直连') + '</span>'
        : esc(proxyText);
      $('#dashProxy').innerHTML = head
        + (rt.length ? ` <span class="tag warn">${rt.length} 个域名已自动切直连</span>`
          + `<span class="hint">（${esc(rt.join(', '))}）</span>` : '');
    } else {
      $('#dashProxy').textContent = proxyText;
    }
  }

  /* --- 首次使用引导（v1.0.0）---
   *
   * 为什么需要它：本版起 example 里预置了 9 家供应商模板（全部 enabled:false、
   * apiKey 统一是占位值）。而 gateway-manager.validateConfigText 会**拒绝保存**
   * 顶层仍是 `dsh-gateway-change-me` 的配置（那是刻意的安全闸：仓库里公开的 Key
   * 等于谁都能白用你的上游额度）。结果是新用户点「保存」只看到一句失败、
   * 却不知道要先去生成 Key —— 旧界面没有任何地方提示这件事。
   *
   * 这里把"还差哪几步"直接摆在首屏，做完哪步就划掉哪步，全做完就整块隐藏。
   */
  renderFirstRun();

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
  renderGuards();
};

/**
 * /health 的账户条目形状（引擎 accountPoolSnapshot 的实际输出，别照猜）：
 *   账户级：{ key, provider, id, state, remainMs, reason?, lastUsed?, orphan? }
 *   模型级：{ key, provider, model, state, remainMs, reason, modelScoped: true }
 * state ∈ 'ok' | 'rate' | 'credit' | 'session'；**没有 cooling 字段**——
 * "在冷却"就是 state !== 'ok'。
 */
function isCooling(a) { return !!a && a.state && a.state !== 'ok'; }

/**
 * 首次使用引导：把"还差哪几步"摆在首屏。
 *
 * 判据都取自**配置实际内容**，不依赖"是否第一次启动"这类状态：
 *  ① 统一 Key 是否还是占位值（validateConfigText 会因此拒绝保存）；
 *  ② 有没有启用中的供应商（预置的 9 家默认全停用 → 一个模型都调不通）；
 *  ③ 有没有真填了 Key 的已启用供应商（只勾启用、没填 Key 也调不通）。
 * 三条都满足就隐藏整块 —— 老用户升级上来不会看到多余的引导。
 */
function renderFirstRun() {
  const card = $('#firstRunCard');
  const body = $('#firstRunBody');
  if (!card || !body) return;

  const key = String((LG.config && LG.config.apiKey) || '').trim();
  const PLACEHOLDER = 'dsh-gateway-change-me';
  const keyIsPlaceholder = key === PLACEHOLDER || key.length < 16;

  const provs = (LG.config && LG.config.providers) || [];
  const enabled = provs.filter((p) => p && p.enabled !== false);
  const placeholderKey = 'sk-llm-gatway-xxxxxxxx';
  const usable = enabled.filter((p) => {
    const k = String((p.apiKey || '') || '').trim();
    if (k && k !== placeholderKey && k.length >= 8) return true;
    // workbuddy 走桌面端凭据（auth: workbuddy），不靠 apiKey
    if (p.auth === 'workbuddy' && Array.isArray(p.accounts) && p.accounts.length) return true;
    return false;
  });

  const steps = [];
  steps.push({
    done: !keyIsPlaceholder,
    text: '生成本机统一 Key',
    detail: keyIsPlaceholder
      ? '当前还是占位值 <code>' + esc(key || '(空)') + '</code>，保存会被拒绝（仓库里的公开 Key 等于谁都能白用你的额度）。'
        + '点下面按钮生成一个随机 Key。'
      : '已设置（<code>' + esc(key.slice(0, 6)) + '…' + esc(key.slice(-4)) + '</code>）。',
    action: keyIsPlaceholder ? { label: '生成并填入', act: 'genkey' } : null,
  });
  steps.push({
    done: enabled.length > 0,
    text: '启用至少一家供应商',
    detail: enabled.length > 0
      ? `已启用 ${enabled.length} 家。`
      : `预置了 ${provs.length} 家模板，但**全部默认停用**。去「供应商」页勾选你要用的那家。`,
    action: enabled.length === 0 ? { label: '去供应商页', act: 'nav:providers' } : null,
  });
  steps.push({
    done: usable.length > 0,
    text: '填入你自己的供应商 Key',
    detail: usable.length > 0
      ? `已有 ${usable.length} 家填好 Key。`
      : '预置条目的 Key 统一是 <code>' + esc(placeholderKey) + '</code>，需要换成你自己的。'
        + '（workbuddy 例外：它读桌面端凭据，在 accounts 里填 authFile 路径即可。）',
    action: null,
  });

  if (steps.every((s) => s.done)) { card.style.display = 'none'; return; }

  card.style.display = '';
  body.innerHTML = '<ol class="firstrun">' + steps.map((s) => {
    const mark = s.done ? '<span class="tag ok">已完成</span>' : '<span class="tag warn">待办</span>';
    const btn = s.action
      ? ` <button class="btn btn-sm" data-firstrun="${attr(s.action.act)}">${esc(s.action.label)}</button>`
      : '';
    return `<li class="${s.done ? 'done' : ''}">${mark} <b>${esc(s.text)}</b>${btn}<div class="hint">${s.detail}</div></li>`;
  }).join('') + '</ol>';

  // 动作委托（只绑一次：用 dataset 标记，避免每次渲染重复叠加监听）
  if (!body.dataset.bound) {
    body.dataset.bound = '1';
    body.addEventListener('click', async (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-firstrun]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-firstrun');
      if (act === 'nav:providers') { LG.go('providers'); return; }
      if (act === 'genkey') {
        // 复用已有的「重新生成统一 Key」按钮逻辑（它带确认弹窗与写盘）
        const b = $('#btnRegenKey');
        if (b) b.click();
      }
    });
  }
}

/* 防护计数（审计 R11）
 *
 * 为什么必须显示：magpie 三项防护（循环守卫 / 工具死循环拦截 / 上下文窗口过滤）默认全开，
 * 但此前界面上一个字都没有。用户既无法确认它们在干活，也无法在它们误伤时发现 ——
 * R10 那个 `pendingHead` 缺陷就是"代码写了、永远不触发、没人察觉"的实例。
 *
 * 三列设计刻意区分两种"0"：
 *   - **关闭**（灰）→ 用户自己关的，或配置里 loopGuard/toolLoop/roomy 设了 false；
 *   - **0 次**（正常色）→ 开着但确实没触发过，这是好事，用说明文字讲清楚。
 * 混在一起会让"关了"看起来像"工作了但没事发生"，那正是我们要避免的那类谎。
 */
function renderGuards() {
  const box = $('#guardsBox');
  if (!box) return;
  if (!LG.state || !LG.state.gateway.running) {
    box.innerHTML = '<div class="empty">网关未运行，暂无数据。</div>';
    return;
  }
  const h = LG.health;
  if (!h) { box.innerHTML = '<div class="empty">正在读取 /health…</div>'; return; }
  const g = h.guards;
  if (!g || typeof g !== 'object') {
    // 老引擎（< 1.0.19）没有这个字段：如实说不支持，而不是画一排 0 假装在工作。
    box.innerHTML = '<div class="empty">当前引擎版本不支持防护计数（v1.0.19 起提供）。</div>';
    return;
  }
  const en = (g && g.enabled) || {};
  const cells = [
    ['循环守卫', g.loopGuard, en.loopGuard, '模型答复陷进"重复同一句话"时主动切断，止损到那一刻'],
    ['工具死循环拦截', g.toolLoop, en.toolLoop, 'agent 连续 8 轮发起同一批调用且结果一样时本地作答，不烧额度'],
    ['上下文窗口过滤', g.roomy, en.roomy, '装不下这次请求的供应商排到最后（不删除），省掉必然超长的一次往返'],
  ];
  box.innerHTML = '<div class="grid grid-3">' + cells.map(([name, n, on, why]) => {
    const count = Number.isFinite(Number(n)) ? Number(n) : 0;
    const state = on
      ? (count > 0
        ? '<span class="tag ok">已生效 ' + esc(String(count)) + ' 次</span>'
        : '<span class="tag">已开启 · 暂未触发</span>')
      : '<span class="tag">已关闭</span>';
    return '<div class="stat-card" title="' + attr(why) + '">'
      + '<div class="stat-label">' + esc(name) + '</div>'
      + '<div class="stat-value">' + (on ? esc(String(count)) : '<span class="hint">—</span>') + '</div>'
      + '<div class="stat-sub">' + state + '</div>'
      + '</div>';
  }).join('') + '</div>'
    + '<div class="hint" style="margin-top:8px;">'
    + (en.roomyLearn
      ? '上下文窗口会额外从上游目录学习（roomyLearn 已开）。'
      : '上下文窗口只认配置里声明的值（roomyLearn 关闭，不外打上游）。')
    + '计数只在本进程内累计，重启归零；历史记录看日志里的 <span class="mono">[loop]</span> 与 '
    + '<span class="mono">[route] … 装不下的候选</span> 行。</div>';
}

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
    box.innerHTML = '<div class="empty">没有已启用的供应商（或它们都还没填 Key —— 填了 Key 才会出现在这里）。</div>';
    return;
  }
  const rows = accts.map((a) => {
    const cooling = isCooling(a);
    const kind = COOL_KIND[a.state] || { text: a.state || '冷却', cls: 'warn' };
    const state = cooling
      ? `<span class="tag ${kind.cls}">${esc(kind.text)}</span>`
      : '<span class="tag ok">可用</span>';
    const remain = cooling ? `<span class="mono">剩 ${esc(fmtRemain(Date.now() + Number(a.remainMs || 0)))}</span>` : '';
    // 冷却范围：单 Key 家没有账户池，它的状态记在**供应商级熔断**上（见引擎 accountPoolSnapshot）
    const scope = a.singleKey
      ? '<span class="tag sm">供应商级</span>'
      : (a.modelScoped
        ? `<span class="tag sm purple">模型级 · ${esc(a.model || '')}</span>`
        : '<span class="tag sm">账户级</span>');
    const flags = []
      .concat(a.lastUsed ? ['<span class="tag sm info">最近使用</span>'] : [])
      .concat(a.singleKey ? ['<span class="tag sm">单 Key</span>'] : [])
      .concat(a.orphan ? ['<span class="tag sm warn">配置已移除</span>'] : [])
      .join(' ');
    const detail = a.reason ? `<span class="hint">${esc(String(a.reason).slice(0, 100))}</span>` : '';
    return `<tr>
      <td><span class="mono">${esc(a.provider || (a.key || '').split('#')[0])}</span></td>
      <td><span class="mono">${esc(a.singleKey ? '—' : (a.id || (a.key || '').split('#')[1] || '—'))}</span></td>
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
  if (!LG.state || !LG.state.gateway.running) {
    LG.health = null;
    renderHealth();
    renderGuards();
    return;
  }
  try {
    LG.health = await window.lgw.gwHealth();
  } catch (_) {
    LG.health = { ok: false, error: 'IPC 失败' };
  }
  // 只重绘，不在这里另写 #dashAccounts —— 同一元素被两处写会造成
  // "统计卡显示『无』而副标题显示『正在读取』"这种自相矛盾的画面（实测踩到）。
  if (LG.activeView === 'dashboard') LG.renders.dashboard();
  else { renderHealth(); renderGuards(); }
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
