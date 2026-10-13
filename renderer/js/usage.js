// usage.js —— 「使用记录」页（阶段 3）
//
// 数据来自 preload 的 `lgw.gwUsage({days, filter, detailLimit})`（见 src/usage.js）。
// 图表用**内联 SVG** 手绘：不需要 canvas，字符串拼装即可，且随容器自适应。
//
// 设计要点：
//   · 环形图取**前 N 项 + 其它**，否则几十个模型会切成一圈碎屑、颜色也不够分；
//   · 趋势图按天，缓存命中率走**右轴**（0–100%）—— 与 token 数量级差太远，同轴会压成一条平线；
//   · 明细表在渲染层做筛选（数据已全在内存），避免每次点筛选都打一次 IPC。

(function () {
  const LG = (window.LG = window.LG || {});
  LG.renders = LG.renders || {};

  const state = { days: 7, data: null, loading: false, filter: { model: '', provider: '', status: '' }, err: '' };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const nf = (n) => Number(n || 0).toLocaleString('zh-CN');
  /** token 数量级大，用紧凑写法（12.3k / 1.2M）免得表格被撑爆 */
  const compact = (n) => {
    const v = Number(n || 0);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  };
  const ms = (n) => {
    const v = Number(n || 0);
    return v >= 1000 ? (v / 1000).toFixed(2) + 's' : v + 'ms';
  };
  const pct = (x) => (Number(x || 0) * 100).toFixed(1) + '%';

  const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16', '#ec4899', '#64748b'];

  /* ---------------- 环形图 ---------------- */

  /**
   * 环形图 + 图例。
   * 取前 maxSlices 项，其余合并成「其它」—— 否则几十个模型会切成一圈碎屑。
   */
  function donut(items, valueKey, maxSlices) {
    const list = (items || []).filter((x) => Number(x[valueKey]) > 0);
    if (!list.length) return '<div class="usage-empty">暂无数据</div>';
    const top = list.slice(0, maxSlices || 6);
    const rest = list.slice(maxSlices || 6);
    const restSum = rest.reduce((a, x) => a + Number(x[valueKey] || 0), 0);
    if (restSum > 0) top.push({ __other: true, __n: rest.length, [valueKey]: restSum });
    const total = top.reduce((a, x) => a + Number(x[valueKey] || 0), 0) || 1;

    const R = 54; const C = 2 * Math.PI * R;
    let off = 0;
    const arcs = top.map((x, i) => {
      const frac = Number(x[valueKey] || 0) / total;
      const len = frac * C;
      const seg = '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + PALETTE[i % PALETTE.length]
        + '" stroke-width="22" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2)
        + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 70 70)"></circle>';
      off += len;
      return seg;
    }).join('');

    const legend = top.map((x, i) => {
      const label = x.__other ? ('其它（' + x.__n + ' 项）') : String(x.model || x.provider || x.endpoint || '?');
      const v = Number(x[valueKey] || 0);
      return '<div class="usage-legend-row">'
        + '<span class="usage-dot" style="background:' + PALETTE[i % PALETTE.length] + '"></span>'
        + '<span class="usage-legend-name" title="' + esc(label) + '">' + esc(label) + '</span>'
        + '<span class="usage-legend-val">' + compact(v) + '</span>'
        + '<span class="usage-legend-pct">' + (v / total * 100).toFixed(1) + '%</span>'
        + '</div>';
    }).join('');

    return '<div class="usage-donut-wrap">'
      + '<svg viewBox="0 0 140 140" class="usage-donut">'
      + '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="var(--border)" stroke-width="22"></circle>'
      + arcs + '</svg>'
      + '<div class="usage-legend">' + legend + '</div>'
      + '</div>';
  }

  /* ---------------- 折线图（Token 趋势 + 缓存命中率右轴） ---------------- */

  function trend(byDay) {
    const rows = byDay || [];
    if (rows.length < 1) return '<div class="usage-empty">暂无数据</div>';
    const W = 720; const H = 200; const PL = 52; const PR = 48; const PT = 12; const PB = 26;
    const iw = W - PL - PR; const ih = H - PT - PB;

    const series = [
      { key: 'inTok', name: 'Input', color: '#3b82f6' },
      { key: 'outTok', name: 'Output', color: '#10b981' },
      { key: 'cacheWrite', name: 'Cache Creation', color: '#f59e0b' },
      { key: 'cacheRead', name: 'Cache Read', color: '#06b6d4' },
    ];
    let maxV = 0;
    for (const r of rows) for (const s of series) maxV = Math.max(maxV, Number(r[s.key] || 0));
    maxV = maxV || 1;

    const x = (i) => PL + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const y = (v) => PT + ih - (Number(v || 0) / maxV) * ih;
    const yP = (v) => PT + ih - Math.max(0, Math.min(1, Number(v || 0))) * ih;   // 右轴 0–100%

    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const yy = PT + ih - f * ih;
      return '<line x1="' + PL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + yy.toFixed(1)
        + '" stroke="var(--border)" stroke-width="1"></line>'
        + '<text x="' + (PL - 8) + '" y="' + (yy + 4).toFixed(1) + '" text-anchor="end" class="usage-axis">'
        + compact(maxV * f) + '</text>'
        + '<text x="' + (W - PR + 8) + '" y="' + (yy + 4).toFixed(1) + '" class="usage-axis usage-axis-r">'
        + Math.round(f * 100) + '%</text>';
    }).join('');

    const lines = series.map((s) => {
      const pts = rows.map((r, i) => x(i).toFixed(1) + ',' + y(r[s.key]).toFixed(1)).join(' ');
      return '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round"></polyline>';
    }).join('');

    // 缓存命中率（右轴）
    const hitPts = rows.map((r, i) => x(i).toFixed(1) + ',' + yP(r.cacheHitRate).toFixed(1)).join(' ');
    const hit = '<polyline points="' + hitPts + '" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-dasharray="4 3"></polyline>';

    const xlab = rows.map((r, i) => {
      if (rows.length > 8 && i % Math.ceil(rows.length / 8) !== 0 && i !== rows.length - 1) return '';
      return '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" class="usage-axis">'
        + esc(String(r.day).slice(5)) + '</text>';
    }).join('');

    const legend = series.map((s) => '<span class="usage-lg"><i style="background:' + s.color + '"></i>' + s.name + '</span>').join('')
      + '<span class="usage-lg"><i style="background:#8b5cf6"></i>Cache Hit Rate</span>';

    return '<div class="usage-lg-row">' + legend + '</div>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" class="usage-trend" preserveAspectRatio="none">'
      + grid + lines + hit + xlab + '</svg>';
  }

  /* ---------------- 明细表 ---------------- */

  function detailTable(rows) {
    const f = state.filter;
    const list = (rows || []).filter((r) => (!f.model || r.model === f.model)
      && (!f.provider || r.provider === f.provider)
      && (!f.status || r.status === f.status));
    if (!list.length) return '<div class="usage-empty">没有匹配的调用记录</div>';
    const body = list.slice(0, 300).map((r) => {
      const bad = r.status !== 'ok';
      return '<tr>'
        + '<td class="usage-t">' + esc(r.day.slice(5)) + ' ' + esc(r.time) + '</td>'
        + '<td>' + esc(r.model) + '</td>'
        + '<td>' + esc(r.provider) + '</td>'
        + '<td class="usage-mono">' + esc(r.endpoint) + '</td>'
        + '<td><span class="usage-badge ' + (bad ? 'bad' : 'ok') + '">' + esc(r.status) + '</span></td>'
        + '<td>' + (r.stream ? '流式' : '非流') + '</td>'
        + '<td class="usage-num">' + nf(r.inTok) + '</td>'
        + '<td class="usage-num">' + nf(r.outTok) + '</td>'
        + '<td class="usage-num">' + nf(r.cacheRead) + '</td>'
        + '<td class="usage-num">' + nf(r.totalTok) + '</td>'
        + '<td class="usage-num">' + ms(r.durMs) + '</td>'
        + '</tr>';
    }).join('');
    const more = list.length > 300 ? '<div class="hint">仅显示最近 300 条（共 ' + nf(list.length) + ' 条匹配）</div>' : '';
    return '<div class="usage-scroll"><table class="usage-table"><thead><tr>'
      + '<th>时间</th><th>模型</th><th>供应商</th><th>端点</th><th>状态</th><th>方式</th>'
      + '<th>输入</th><th>输出</th><th>缓存读</th><th>合计</th><th>耗时</th>'
      + '</tr></thead><tbody>' + body + '</tbody></table></div>' + more;
  }

  function dimTable(rows, keyName, title) {
    if (!rows || !rows.length) return '<div class="usage-empty">暂无数据</div>';
    const body = rows.map((r) => '<tr>'
      + '<td title="' + esc(r[keyName]) + '">' + esc(r[keyName]) + '</td>'
      + '<td class="usage-num">' + nf(r.requests) + '</td>'
      + '<td class="usage-num">' + compact(r.totalTok) + '</td>'
      + '<td class="usage-num">' + compact(r.cacheRead) + '</td>'
      + '<td class="usage-num">' + pct(r.cacheHitRate) + '</td>'
      + '<td class="usage-num">' + ms(r.avgDurMs) + '</td>'
      + '<td class="usage-num">' + (r.fail ? '<span class="usage-badge bad">' + r.fail + '</span>' : '<span class="usage-badge ok">0</span>') + '</td>'
      + '</tr>').join('');
    return '<div class="usage-scroll"><table class="usage-table"><thead><tr>'
      + '<th>' + esc(title) + '</th><th>请求</th><th>Token</th><th>缓存读</th><th>命中率</th><th>平均耗时</th><th>失败</th>'
      + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  /* ---------------- 渲染 ---------------- */

  function card(label, value, sub, cls) {
    return '<div class="usage-card"><div class="usage-card-label">' + esc(label) + '</div>'
      + '<div class="usage-card-value ' + (cls || '') + '">' + value + '</div>'
      + (sub ? '<div class="usage-card-sub">' + sub + '</div>' : '') + '</div>';
  }

  LG.renders.usage = function renderUsage() {
    const el = document.getElementById('view-usage');
    if (!el) return;
    const d = state.data;

    // ⚠ 首次进入时**自动拉取**。
    //
    // 本来 load() 要调用方显式调，但 `switchView()`（core.js）只会调
    // `LG.renders[name]()` —— **不会**调 load。于是切到本页时 state.data 恒为 null，
    // 页面一直显示"暂无数据"，而数据其实早在磁盘上
    //（实测踩到：磁盘已有 9 条记录，页面却空白）。
    // 在这里兜住：没数据、没在加载、没出错 → 自己去拉。
    // 不会死循环：load() 立即置 loading=true（下一次 render 走"加载中…"分支），
    // 完成后 load() 再调一次 render 出内容。
    if (!d && !state.loading && !state.err) {
      el.innerHTML = '<div class="usage-empty">加载中…</div>';
      load();
      return;
    }
    if (state.loading && !d) { el.innerHTML = '<div class="usage-empty">加载中…</div>'; return; }
    if (state.err) { el.innerHTML = '<div class="usage-empty">读取失败：' + esc(state.err) + '</div>'; return; }
    if (!d || !d.totals) { el.innerHTML = '<div class="usage-empty">暂无数据 —— 网关产生调用后这里会自动出现记录</div>'; return; }

    const t = d.totals;
    const head = '<div class="usage-head">'
      + '<div class="usage-range">'
      + [1, 7, 30, 90].map((n) => '<button class="btn ' + (state.days === n ? 'btn-primary' : '') + '" data-usage-days="' + n + '">' + n + ' 天</button>').join('')
      + '</div>'
      + '<div class="hint">共 ' + nf(d.rows) + ' 条记录' + (d.totalRows !== d.rows ? '（全量 ' + nf(d.totalRows) + '）' : '') + '</div>'
      + '<button class="btn" data-usage-refresh="1">刷新</button>'
      + '</div>';

    const cards = '<div class="usage-cards">'
      + card('总请求数', nf(t.requests), '成功 ' + nf(t.ok) + ' / 失败 ' + nf(t.fail))
      + card('总 Token', compact(t.totalTok),
        '输入 ' + compact(t.totalIn) + ' / 输出 ' + compact(t.outTok) + ' / 缓存读 ' + compact(t.cacheRead))
      + card('缓存命中率', pct(t.cacheHitRate), '缓存读 ' + compact(t.cacheRead) + ' / 总输入 ' + compact(t.totalIn),
        t.cacheHitRate >= 0.5 ? 'good' : '')
      + card('平均耗时', ms(t.avgDurMs), t.avgTtfbMs ? '平均首字节 ' + ms(t.avgTtfbMs) : '')
      + '</div>';

    const panels = [
      ['模型分布', donut(d.byModel, 'totalTok', 6), dimTable(d.byModel, 'model', '模型')],
      ['供应商分布', donut(d.byProvider, 'totalTok', 6), dimTable(d.byProvider, 'provider', '供应商')],
      ['端点分布', donut(d.byEndpoint, 'totalTok', 6), dimTable(d.byEndpoint, 'endpoint', '端点')],
    ].map(([title, chart, table]) => '<div class="usage-panel"><h3>' + esc(title) + '</h3>'
      + chart + table + '</div>').join('');

    const trendPanel = '<div class="usage-panel"><h3>Token 使用趋势</h3>' + trend(d.byDay) + '</div>';

    const o = d.options || {};
    const sel = (name, label, values) => '<label class="usage-filter"><span>' + label + '</span>'
      + '<select class="input" data-usage-filter="' + name + '">'
      + '<option value="">全部</option>'
      + (values || []).map((v) => '<option value="' + esc(v) + '"' + (state.filter[name] === v ? ' selected' : '') + '>' + esc(v) + '</option>').join('')
      + '</select></label>';

    const detailPanel = '<div class="usage-panel"><h3>调用明细</h3>'
      + '<div class="usage-filters">'
      + sel('model', '模型', o.models) + sel('provider', '供应商', o.providers) + sel('status', '状态', o.statuses)
      + '<button class="btn" data-usage-clear="1">清空筛选</button>'
      + '</div>'
      + detailTable(d.detail) + '</div>';

    el.innerHTML = head + cards + panels + trendPanel + detailPanel;
    bind(el);
  };

  function bind(el) {
    el.querySelectorAll('[data-usage-days]').forEach((b) => b.addEventListener('click', () => {
      state.days = Number(b.dataset.usageDays);
      load();
    }));
    const rf = el.querySelector('[data-usage-refresh]');
    if (rf) rf.addEventListener('click', () => load());
    el.querySelectorAll('[data-usage-filter]').forEach((s) => s.addEventListener('change', () => {
      state.filter[s.dataset.usageFilter] = s.value;
      LG.renders.usage();          // 明细筛选在渲染层做，不打 IPC
    }));
    const cl = el.querySelector('[data-usage-clear]');
    if (cl) cl.addEventListener('click', () => {
      state.filter = { model: '', provider: '', status: '' };
      LG.renders.usage();
    });
  }

  async function load() {
    state.loading = true;
    state.err = '';
    LG.renders.usage();
    try {
      const r = await window.lgw.gwUsage({ days: state.days, detailLimit: 3000 });
      if (r && r.error) state.err = r.error;
      else state.data = r;
    } catch (e) {
      state.err = (e && e.message) || String(e);
    } finally {
      state.loading = false;
      LG.renders.usage();
    }
  }

  /** 切到该页时按需加载（数据不变就不重复打 IPC） */
  LG.usage = { load, state };
})();
