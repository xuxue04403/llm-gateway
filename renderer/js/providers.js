/* providers.js — 供应商列表、拖拽排序、连通性测试、编辑抽屉 */
'use strict';

let dragIndex = -1;
let editingIndex = -1;
// 「＋ 添加供应商」会先插一条空记录再打开抽屉。若用户点「取消」，必须把这条回滚掉 ——
// 否则留下一个没有 baseURL 的空供应商，之后**保存会被校验拦下**
//（"供应商 provider-N 缺少 baseURL"），用户还得自己去找出来删掉。
// 实测：连点 3 次「添加 → 取消」会在配置里留下 3 个空供应商。
let pendingNewIndex = -1;
// 当前「在世」的模型选择器弹窗标记。测速是异步的，回填前必须确认弹窗没被关掉/换成新的 ——
// 否则会把上一轮的结果写进新弹窗的表格里（实测：A 弹窗的 11111/22222 显示在了 B 弹窗里）。
let livePickerToken = null;

/* ==================== 列表 ==================== */

function filteredProviders() {
  const q = String(($('#pvSearch') || {}).value || '').trim().toLowerCase();
  const list = (LG.config && LG.config.providers) || [];
  if (!q) return list.map((p, i) => ({ p, i }));
  return list.map((p, i) => ({ p, i })).filter(({ p }) => {
    const hay = [p.id, p.baseURL, p.protocol, p.clientProfile, p.auth]
      .concat(modelEntriesOf(p).map((e) => e.up + ' ' + e.as)).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

LG.renders.providers = function renderProviders() {
  const box = $('#provList');
  if (!LG.config) return;
  const rows = filteredProviders();
  const total = (LG.config.providers || []).length;
  $('#provEmpty').classList.toggle('hidden', total > 0);
  if (total === 0) { box.innerHTML = ''; return; }

  box.innerHTML = rows.map(({ p, i }) => {
    const models = modelEntriesOf(p);
    const logical = new Set(models.map((e) => e.as));
    const t = LG.testResults[p.id];
    const dotCls = !t ? '' : (t.busy ? 'busy' : (t.ok === true ? 'ok' : (t.ok === null ? '' : 'bad')));
    const keys = Array.isArray(p.apiKeys) && p.apiKeys.length ? p.apiKeys.length : (p.apiKey ? 1 : 0);
    const tags = [];
    if (p.protocol) tags.push(`<span class="tag sm">${esc(p.protocol)}</span>`);
    if (p.clientProfile) tags.push(`<span class="tag sm purple">仿真 ${esc(p.clientProfile)}</span>`);
    if (p.auth) tags.push(`<span class="tag sm info">${esc(p.auth)}</span>`);
    if (keys > 1) tags.push(`<span class="tag sm info">${keys} 把 Key</span>`);
    if (p.timeoutMs) tags.push(`<span class="tag sm">超时 ${esc(p.timeoutMs)}ms</span>`);
    if (p.proxy === false || p.noProxy === true) tags.push('<span class="tag sm">直连</span>');
    return `
    <div class="prov ${p.enabled === false ? 'off' : ''}" draggable="true" data-idx="${i}">
      <span class="handle" title="拖拽调整同级顺序">⣿</span>
      <span class="idx">#${i + 1}</span>
      <label class="switch" title="启用 / 停用"><input type="checkbox" data-act="toggle" data-idx="${i}" ${p.enabled === false ? '' : 'checked'} /><span></span></label>
      <div class="main">
        <div class="name">
          <span class="test-dot ${dotCls}" title="${attr(t ? (t.verdict || '') : '未测试')}"></span>
          <b>${esc(p.id || '(未命名)')}</b>
          <span class="tag sm">优先级 ${esc(p.priority == null ? 1 : p.priority)}</span>
          ${tags.join('')}
        </div>
        <div class="url" title="${attr(p.baseURL || '')}">${esc(p.baseURL || '(缺 baseURL)')} · ${logical.size} 个模型</div>
        ${t && t.verdict ? `<div class="url" style="color:${t.ok === true ? '#7ee2a8' : (t.ok === null ? '#ffd479' : '#ff9a9a')}">${esc(t.verdict)}</div>` : ''}
      </div>
      <div class="meta">
        <button class="btn btn-sm" data-act="test" data-idx="${i}">测试</button>
        <button class="btn btn-sm" data-act="edit" data-idx="${i}">编辑</button>
      </div>
      <div class="actions">
        <button class="icon-btn" data-act="up" data-idx="${i}" title="上移">▲</button>
        <button class="icon-btn" data-act="down" data-idx="${i}" title="下移">▼</button>
      </div>
    </div>`;
  }).join('');

  wireProviderRows();
};

function wireProviderRows() {
  const box = $('#provList');

  box.querySelectorAll('[data-act]').forEach((n) => {
    n.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const i = Number(n.dataset.idx);
      const act = n.dataset.act;
      const list = LG.config.providers;
      if (act === 'edit') return openEditor(i);
      if (act === 'up' && i > 0) { swap(list, i, i - 1); markDirty('供应商顺序'); LG.renders.providers(); return; }
      if (act === 'down' && i < list.length - 1) { swap(list, i, i + 1); markDirty('供应商顺序'); LG.renders.providers(); return; }
      if (act === 'test') return testOne(list[i]);
      return undefined;
    });
  });

  box.querySelectorAll('input[data-act="toggle"]').forEach((n) => {
    n.addEventListener('change', () => {
      const i = Number(n.dataset.idx);
      LG.config.providers[i].enabled = n.checked;
      markDirty('启用状态');
      LG.renders.providers();
      LG.renders.models();
      renderTopbar();
    });
  });

  // ---- 拖拽排序（只改数组顺序，不改 priority）----
  box.querySelectorAll('.prov').forEach((row) => {
    // 双击卡片任意空白处 = 打开编辑抽屉（卡片上已经有「编辑」按钮，但双击是更顺手的习惯动作）。
    // 注意别和拖拽冲突：拖拽不会触发 dblclick，所以两者可以共存。
    // 卡片内部的可交互元素（按钮/复选框/链接）要排除掉，否则双击"启用"开关也会弹抽屉。
    row.addEventListener('dblclick', (e) => {
      // ⚠ 排除清单必须包含 `label.switch`：启用开关是 `<label class="switch"><input data-act="toggle">…</label>`，
      // 用户看到的圆形滑块是 label **里面**的 span —— 只排除 input 的话，
      // 双击滑块（那正是用户会去点的位置）仍会弹出编辑抽屉。实测确认。
      if (e.target.closest('button, input, select, textarea, a, label, [data-act]')) return;
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;      // 用户是在选文字，不是双击打开
      openEditor(Number(row.dataset.idx));
    });
    row.style.cursor = 'pointer';

    row.addEventListener('dragstart', (e) => {
      dragIndex = Number(row.dataset.idx);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragIndex)); } catch (_) { /* 忽略 */ }
    });
    row.addEventListener('dragend', () => {
      dragIndex = -1;
      box.querySelectorAll('.prov').forEach((r) => r.classList.remove('dragging', 'drop-target'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const from = dragIndex;
      const to = Number(row.dataset.idx);
      if (from < 0 || from === to) return;
      moveItem(LG.config.providers, from, to);
      markDirty('供应商顺序');
      LG.renders.providers();
    });
  });
}

function swap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

function moveItem(arr, from, to) {
  const [it] = arr.splice(from, 1);
  arr.splice(to, 0, it);
}

/* ==================== 连通性测试 ==================== */

async function testOne(p) {
  if (!p || !p.id) return;
  LG.testResults[p.id] = { busy: true };
  LG.renders.providers();
  // 同 testAll：无论成败都必须把 busy 清掉，否则卡片上的圆点永久转圈
  let r = null;
  try {
    r = await window.lgw.gwTestProviders([p.id]);
  } catch (e) {
    LG.testResults[p.id] = { ok: false, verdict: '测试失败：' + ((e && e.message) || e) };
    LG.renders.providers();
    toast(`${p.id}：测试失败`, 'err', 6000);
    return;
  }
  const one = (r && r.results && r.results[0]) || { ok: false, verdict: (r && r.error) || '探测失败' };
  LG.testResults[p.id] = one;
  LG.renders.providers();
  toast(`${p.id}：${one.verdict || ''}`, one.ok === true ? 'ok' : (one.ok === null ? 'warn' : 'err'), 6000);
}

async function testAll() {
  const list = LG.config.providers || [];
  if (list.length === 0) return;
  list.forEach((p) => { LG.testResults[p.id] = { busy: true }; });
  LG.renders.providers();
  toast(`正在测试 ${list.length} 家供应商的连通性…`, '', 3000);

  // ⚠ r 可能是 null（裸快照通道 / IPC 异常）或 {ok:false}。
  // 旧实现只给第 171 行加了 `r &&`，173/174/177 直接读 `r.results` ——
  //   · r=null  → TypeError（async 监听器无 try/catch → unhandled rejection），
  //              而且 LG.testResults 里的 busy 永不清除 → 卡片上的圆点**永久转圈**
  //   · r={ok:false} → 谎报"0 家正常 / 0 家异常 / 其余未知"，用户以为测过了
  // 这里统一取一次、判 ok、并且无论成败都要把 busy 清干净。
  let r = null;
  try {
    r = await window.lgw.gwTestProviders(list.map((p) => p.id));
  } catch (e) {
    list.forEach((p) => { delete LG.testResults[p.id]; });
    LG.renders.providers();
    toast('连通性测试失败：' + ((e && e.message) || e), 'err', 8000);
    return;
  }
  const results = (r && Array.isArray(r.results)) ? r.results : [];
  if (!results.length) {
    // 一家都没测到 —— 必须如实说，不能报成"0 家正常"让人以为测过了
    list.forEach((p) => { delete LG.testResults[p.id]; });
    LG.renders.providers();
    toast('连通性测试没有返回任何结果：' + ((r && r.error) || '未知原因'), 'err', 8000);
    return;
  }
  results.forEach((x) => { if (x && x.id) LG.testResults[x.id] = x; });
  // 主进程没回的那些（被整体预算截断之外的极端情况）也要把 busy 清掉，否则圆点一直转
  list.forEach((p) => {
    const cur = LG.testResults[p.id];
    if (cur && cur.busy) delete LG.testResults[p.id];
  });
  LG.renders.providers();
  const okN = results.filter((x) => x.ok === true).length;
  const badN = results.filter((x) => x.ok === false).length;
  // 整体时间预算用完时主进程会返回 skipped 条目 —— 如实告诉用户"还有几家没测"，
  // 而不是把它们混进"其余未知"里让人以为都测过了。
  const skipN = results.filter((x) => x.skipped).length;
  toast(`连通性测试完成：${okN} 家正常 / ${badN} 家异常`
    + (skipN ? ` / ${skipN} 家未测（时间预算用完，请单独测试）` : ' / 其余未知'),
  badN ? 'warn' : 'ok', 6000);
}

/* ==================== 编辑抽屉 ==================== */

const QT_KNOWN = ['force-stream', 'stringify-tool-choice', 'prepend-system', 'drop-thinking'];
const HEADER_PLACEHOLDER = 'User-Agent: Cline/3.0.47\nX-CLIENT-TYPE: cline-sdk';

function openEditor(i) {
  editingIndex = i;
  const p = LG.config.providers[i] || {};
  $('#editorTitle').textContent = '供应商配置：' + (p.id || '(新建)');
  $('#btnEditorDelete').style.visibility = i >= 0 ? 'visible' : 'hidden';

  const keys = Array.isArray(p.apiKeys) && p.apiKeys.length ? p.apiKeys.join('\n') : (p.apiKey || '');
  const models = modelEntriesOf(p);
  const accountsText = Array.isArray(p.accounts) ? JSON.stringify(p.accounts, null, 2) : '';
  const headersText = (p.headers && typeof p.headers === 'object')
    ? Object.keys(p.headers).map((k) => k + ': ' + p.headers[k]).join('\n')
    : '';

  $('#editorBody').innerHTML = `
    <div class="form-grid" style="grid-template-columns:110px 1fr;">
      <label>ID</label>
      <div class="field"><input class="input" id="edId" value="${attr(p.id || '')}" placeholder="唯一标识，如 my-relay" /></div>

      <label>Base URL</label>
      <div class="field"><input class="input" id="edUrl" value="${attr(p.baseURL || '')}" placeholder="https://api.example.com/v1" /></div>

      <label>API Key</label>
      <div class="field" style="align-items:flex-start;">
        <textarea class="code" id="edKeys" rows="3" placeholder="每行一把；第 1 行为主 Key，填 ≥2 把自动轮换（额度耗尽/失效/限流换下一把）">${esc(keys)}</textarea>
      </div>

      <label>优先级</label>
      <div class="field">
        <input class="input short" type="number" id="edPriority" min="1" value="${attr(p.priority == null ? 1 : p.priority)}" />
        <span class="hint">数字小者先试；同级内按列表顺序</span>
      </div>

      <label>启用</label>
      <div class="field"><label class="switch"><input type="checkbox" id="edEnabled" ${p.enabled === false ? '' : 'checked'} /><span></span></label></div>
    </div>

    <h4 class="section-title">模型映射
      <span class="hint">上游真实 ID ↔ 网关路由名（客户端用的名字）</span>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" id="edFetchAll" title="拉取该上游的全部模型，自动填好上下文长度/图片能力/超时，并自动把 deepseek-ai/deepseek-v4.1-flash 这类名字映射成 deepseek-v4.1-flash">⚡ 一键获取全部模型</button>
      <button class="btn btn-sm btn-ghost" id="edFetchCatalog">仅拉取 ID 列表</button>
    </h4>
    <div class="table-wrap" style="max-height:300px;">
      <table class="tbl" id="edModelTable">
        <thead><tr><th style="width:26%">上游模型 ID</th><th style="width:17%">映射为（留空=同名）</th><th style="width:9%" title="该模型的上游协议（逐模型）。留空 = 跟随供应商级 protocol，再不行跟随客户端。按模型区分协议的上游（如 opencode-go）留空会直接 400。">协议</th><th style="width:6%" title="勾选后才能向该模型发图">图片</th><th style="width:12%">上下文</th><th style="width:11%">最大输出</th><th style="width:11%" title="留空则用供应商级的超时">超时(ms)</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="row-inline" style="margin-top:8px;">
      <button class="btn btn-sm" id="edAddModel">＋ 添加一行</button>
      <button class="btn btn-sm btn-ghost" id="edPasteToggle">批量粘贴…</button>
      <span class="hint" id="edModelCount"></span>
    </div>
    <div class="hidden" id="edPasteBox" style="margin-top:8px;">
      <textarea class="code" id="edPaste" rows="4" placeholder="deepseek-ai/deepseek-v4-flash => deepseek-v4-flash&#10;glm-5.3"></textarea>
      <div class="row-inline" style="margin-top:6px;">
        <button class="btn btn-sm" id="edPasteImport">导入（追加到上表）</button>
        <span class="hint">分隔符支持 =&gt; / -&gt; / =；空行与 # 开头忽略</span>
      </div>
    </div>

    <details class="adv" style="margin-top:16px;">
      <summary>高级字段（协议 / 兼容开关 / 请求头 / 超时 / 账户池）</summary>
      <div class="form-grid" style="grid-template-columns:130px 1fr;margin-top:10px;">
        <label>上游线协议</label>
        <div class="field">
          <select class="input" id="edProtocol">
            <option value="">（跟随客户端请求路径）</option>
            <option value="openai-chat">openai-chat（该家只会 OpenAI chat）</option>
            <option value="anthropic-messages">anthropic-messages（该家只会 Anthropic）</option>
          </select>
        </div>

        <label>客户端仿真</label>
        <div class="field">
          <select class="input" id="edProfile">
            <option value="">（自动：按主机名推断，再回落全局）</option>
            <option value="cline">cline</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="opencode">opencode（OpenCode 端点必需：补 x-opencode-session 等头）</option>
          </select>
        </div>

        <label>兼容开关</label>
        <div class="field">
          <input class="input" id="edQuirks" value="${attr(Array.isArray(p.quirks) ? p.quirks.join(', ') : (p.quirks || ''))}" placeholder="force-stream, stringify-tool-choice" />
        </div>

        <label>超时 ms</label>
        <div class="field">
          <input class="input short" type="number" id="edTimeout" value="${attr(p.timeoutMs || '')}" placeholder="60000" />
          <span class="hint">到响应头的超时；留空 = 60 秒。声明后熔断半开探测也按它执行</span>
        </div>

        <label>该家直连</label>
        <div class="field">
          <label class="switch"><input type="checkbox" id="edDirect" ${(p.proxy === false || p.noProxy === true) ? 'checked' : ''} /><span></span></label>
          <span class="hint">勾选后该供应商绕过全局代理（等价于配置里的 "proxy": false）</span>
        </div>

        <label>自定义请求头</label>
        <div class="field" style="align-items:flex-start;">
          <textarea class="code" id="edHeaders" rows="3" placeholder="${attr(HEADER_PLACEHOLDER)}">${esc(headersText)}</textarea>
        </div>

        <label>鉴权方式</label>
        <div class="field">
          <select class="input" id="edAuth">
            <option value="">普通 API Key</option>
            <option value="workbuddy">workbuddy（用桌面客户端凭据，自动刷新）</option>
            <option value="codex">codex（用 Codex 桌面版/CLI 的订阅凭据，自动刷新）</option>
          </select>
          <span class="hint">选 workbuddy 后 Key 栏可留空，凭据按平台默认位置自动发现</span>
          <span class="hint">选 <b>codex</b> 后 Key 栏留空即可 —— 凭据从 <code>$CODEX_HOME/auth.json</code>（或 <code>~/.codex/auth.json</code>）读取，
            适用于 ChatGPT Plus/Pro 订阅的 Codex 后端。此时 baseURL 填 <code>https://chatgpt.com/backend-api/codex</code>、
            协议选 <code>openai-responses</code>（这两项网关会按 codex 自动兜底，但填上更直观）</span>
        </div>

        <label>账户池</label>
        <div class="field" style="align-items:flex-start;">
          <textarea class="code" id="edAccounts" rows="4" placeholder='[ { "id": "acct1", "apiKey": "sk-..." }, { "id": "acct2", "authFile": "C:\\...\\workbuddy-desktop.info" } ]'>${esc(accountsText)}</textarea>
        </div>
      </div>
      <p class="hint">可用兼容开关：${QT_KNOWN.map((q) => `<code>${q}</code>`).join(' ')}</p>
    </details>

    <div id="edError" class="guard hidden" style="margin-top:14px;"></div>
  `;

  // 协议 / 仿真的当前值（用 JS 设，避免 option 里再拼 HTML）
  $('#edProtocol').value = p.protocol || '';
  $('#edProfile').value = p.clientProfile || '';
  $('#edAuth').value = p.auth || '';
  // ⚠ 用了"凭据不在配置里"的鉴权方式时，**自动展开**高级字段。
  //
  // 「鉴权方式」下拉在折叠的 <details> 里（它平时是高级设置）。但 codex / workbuddy
  // 这类供应商**整个凭据来源都由这个下拉决定** —— 折起来的话，用户看到一条
  // 空着 API Key 的配置，却找不到该在哪里选鉴权方式（实测反馈：
  // 截图里只有 ID/Base URL/API Key/优先级，然后就被校验拦住说"请至少填一把 API Key"）。
  if (p.auth === 'codex' || p.auth === 'workbuddy') {
    const adv = $('#editorDrawer').querySelector('details.adv');
    if (adv) adv.open = true;
  }

  renderEditorModels(models);
  wireEditor();
  $('#editorMask').classList.remove('hidden');
  $('#editorDrawer').classList.remove('hidden');
}

function closeEditor() {
  // 「取消」时把"刚添加、还没应用过"的那条回滚掉（见 pendingNewIndex 的说明）。
  // applyEditor 成功、deleteEditingProvider、以及"用户点了遮罩/✕"都会走到这里 ——
  // 前两者会先把 pendingNewIndex 清成 -1，所以只有真正的"取消"才会触发回滚。
  if (pendingNewIndex >= 0 && pendingNewIndex < (LG.config.providers || []).length) {
    LG.config.providers.splice(pendingNewIndex, 1);
    pendingNewIndex = -1;
    // 这条从没被 markDirty 过，所以撤销它也不需要清脏 —— 但列表要重绘一次
    LG.renders.providers();
    LG.renders.models();
    renderTopbar();
  }
  pendingNewIndex = -1;
  editingIndex = -1;
  $('#editorMask').classList.add('hidden');
  $('#editorDrawer').classList.add('hidden');
}

/* --- 编辑抽屉里的模型映射表 --- */

function renderEditorModels(list) {
  const tb = $('#edModelTable tbody');
  tb.innerHTML = '';
  (list.length ? list : [{ up: '', as: '' }]).forEach((e) => tb.appendChild(modelRow(e)));
  updateEditorModelCount();
}

/**
 * 逐模型协议的**别名归一**（与引擎 `wireOfName()` 认的拼法一致，见 `model-gateway.mjs`）。
 *
 * ⚠ 为什么必须有这个函数：引擎接受多种拼法（`openai` / `openai-completions` /
 * `responses`…），而下拉框只列得出 3 个规范值。没有归一的话，"打开抽屉 → 点应用"
 * 会把 `api: 'openai'` 读成空值、再写回时**丢掉整个字段**，界面上还显示成「跟随」——
 * 与今天刚修的"一键获取抹掉 api"是同一类静默数据丢失（审计 2026-10-09 D4）。
 *
 * 归一本身是**无损**的：这些拼法在引擎里解析成同一个 wire。
 * 归一不了的（例如用户手写的 `gemini`）返回 null，由调用方原样保留——宁可留着一个
 * 不认识的字符串，也不要静默删掉用户写的东西。
 */
function canonicalApiValue(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  if (s === 'openai-chat' || s === 'openai-completions' || s === 'openai' || s === 'chat') return 'openai-chat';
  if (s === 'anthropic' || s === 'anthropic-messages' || s === 'messages') return 'anthropic-messages';
  if (s === 'openai-responses' || s === 'responses') return 'openai-responses';
  return null;   // 认不出来 → 保留原值
}

function modelRow(e) {
  const tr = el('tr');
  // ⚠ `api` 这一列必须存在，哪怕它平时是「跟随」。
  //
  // 它决定**该模型用哪种上游协议**（一个供应商可以同时挂着三种协议的模型）。
  // 旧实现的模型表只有 图片/上下文/最大输出/超时 四列，于是每次「应用」或
  // 「⚡一键获取全部模型」重建列表时，`api` 都被**静默丢掉** —— 模型退回"跟随客户端协议"，
  // 而 opencode-go 这类**按模型区分协议**的上游会直接回
  // `ModelProtocolUnsupported`（实测：一键获取之后该家 11 个模型全部 400）。
  //
  // 显示为「跟随」是准确的语义：留空 = 用供应商级 protocol，再不行跟随客户端请求。
  const rawApi = String(e.api || '');
  const canon = canonicalApiValue(rawApi);
  const known = [['', '跟随'], ['openai-chat', 'chat'], ['anthropic-messages', 'anth.'], ['openai-responses', 'resp.']];
  // 认不出来的值 → 额外补一个选项把它**原样带下去**（不静默删用户的写法）
  const extra = (rawApi && canon === null) ? [[rawApi, rawApi.length > 10 ? rawApi.slice(0, 9) + '…' : rawApi]] : [];
  const sel = canon === null ? rawApi : canon;
  const opts = known.concat(extra)
    .map(([v, label]) => `<option value="${attr(v)}"${sel === v ? ' selected' : ''}>${esc(label)}</option>`).join('');
  tr.innerHTML = `
    <td><input class="input" data-f="up" value="${attr(e.up || '')}" placeholder="上游真实模型 ID" style="width:100%" /></td>
    <td><input class="input" data-f="as" value="${attr(e.as && e.as !== e.up ? e.as : '')}" placeholder="留空 = 同名" style="width:100%" /></td>
    <td><select class="input" data-f="api" title="该模型的上游协议。留空/跟随 = 用供应商级 protocol，再不行跟随客户端请求。同一家可以混用三种协议，所以这是**逐模型**的 —— 留空会在按模型区分协议的上游上直接 400。">${opts}</select></td>
    <td style="text-align:center;"><input type="checkbox" data-f="vision" ${e.vision ? 'checked' : ''} /></td>
    <td><input class="input" data-f="contextWindow" type="number" value="${attr(e.contextWindow || '')}" placeholder="—" style="width:100%" /></td>
    <td><input class="input" data-f="maxTokens" type="number" value="${attr(e.maxTokens || '')}" placeholder="—" style="width:100%" /></td>
    <td><input class="input" data-f="timeoutMs" type="number" value="${attr(e.timeoutMs || '')}" placeholder="留空=供应商级" title="逐模型超时（毫秒）。留空则用供应商级的值。同一家里慢模型与快模型的速度能差一个数量级，分开设才不会互相拖累。" style="width:100%" /></td>
    <td><button class="icon-btn" data-del="1" title="删除该行">✕</button></td>`;
  tr.querySelector('[data-del]').addEventListener('click', () => {
    tr.remove();
    if (!tb2rows()) renderEditorModels([]);
    updateEditorModelCount();
  });
  tr.querySelectorAll('input, select').forEach((n) => n.addEventListener('input', updateEditorModelCount));
  return tr;
}

/**
 * 「一键获取全部模型」的选择器：把拉回来的模型连同参数摆出来，让用户勾选删减后再应用。
 *
 * 三条刻意的设计：
 *  ① **默认全选**，用户只做减法（拉回来通常就是想全要，逐个勾太累）。
 *  ② **参数标出来源**（上游 / 已知表 / 未提供）—— 让用户知道哪些数字可信、哪些得自己填。
 *     上游没给、已知表也没有的，宁可留空也不编一个（虚报上下文会让客户端真的按那个数字发包）。
 *  ③ **短名冲突要当面说**：自动去前缀可能让两个不同的上游 ID 撞成同一个短名，
 *     那会让客户端以为是同一个模型 —— 必须让用户看见并决定。
 */
function openModelPicker(fetched, probeProvider) {
  // ⚠ 入参守卫。这个函数的调用点目前会先判 ok/models，但它是"点了没反应"这类事故的高发处
  //（上游返回畸形、preload 版本不匹配都可能把形状变掉），所以自己再挡一道。
  const models = (fetched && Array.isArray(fetched.models)) ? fetched.models : [];
  const unknownList = (fetched && Array.isArray(fetched.unknown)) ? fetched.unknown : [];
  const rows = models
    .filter((m) => m && typeof m === 'object' && (m.id !== undefined || m.as !== undefined))
    .map((m) => Object.assign({ _keep: true, _tmo: Number(m.timeoutMs) > 0 ? Number(m.timeoutMs) : 0 }, m));
  if (!rows.length) { toast('上游目录里没有可用的模型条目', 'warn', 6000); return; }
  const srcOf = (m, k) => (m._src && m._src[k]) || '';

  // 数字列一律先收敛再渲染：`contextWindow` 现在由 model-meta 保证是数字，但那是**另一个模块**
  // 的保证。这里若直接 `${m.contextWindow.toLocaleString()}`，一旦上游透出字符串
  //（`String.prototype.toLocaleString` 返回自身）就会把任意 HTML 插进 innerHTML。
  // 实测：喂 `contextWindow: '<img src=x onerror=…>'` 会真的生成 img 元素。
  // 所以三道都要有：Number 收敛 → 非有限值当空 → 插值前还过 esc（防御性）。
  const fmtNum = (v) => {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? esc(n.toLocaleString()) : '';
  };

  // 短名冲突检测（同一批里 as 撞车）
  const nameCount = new Map();
  rows.forEach((m) => {
    const k = String(m.as || m.id).toLowerCase();
    nameCount.set(k, (nameCount.get(k) || 0) + 1);
  });
  const dups = [...nameCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  const cells = rows.map((m, i) => {
    const key = String(m.as || m.id).toLowerCase();
    const dup = nameCount.get(key) > 1;
    return `<tr data-i="${i}">
      <td style="text-align:center"><input type="checkbox" data-keep ${m._keep ? 'checked' : ''} /></td>
      <td class="mono" style="word-break:break-all">${esc(m.id)}</td>
      <td class="mono" style="word-break:break-all${dup ? ';color:#ffcf70' : ''}" title="${dup ? '与同批另一个模型映射成了同一个名字，客户端会分不清' : ''}">${esc(m.as || m.id)}${dup ? ' ⚠' : ''}</td>
      <td style="text-align:center">${m.vision ? '✔' : '<span class="hint">—</span>'}</td>
      <td style="text-align:right" title="${attr(srcOf(m, 'contextWindow'))}">${fmtNum(m.contextWindow) || '<span class="hint">—</span>'}</td>
      <td style="text-align:right">${fmtNum(m.maxTokens) || '<span class="hint">—</span>'}</td>
      <td style="text-align:right" data-tmo>${fmtNum(m._tmo) || '<span class="hint" data-notmo>—</span>'}</td>
    </tr>`;
  }).join('');

  const body = `
    <p>从上游目录拿到 <b>${rows.length}</b> 个模型，已按规则自动映射短名
      （<code>deepseek-ai/deepseek-v4.1-flash</code> → <code>deepseek-v4.1-flash</code>）。
      默认全选，<b>取消勾选即不写入</b>。</p>
    ${dups.length ? `<p class="warn-box">⚠ 有 ${dups.length} 个短名被多个上游模型共用（表中标 ⚠）：客户端会把它们当成同一个模型。
      建议改掉这些行的「映射为」，或在应用后手工调整。</p>` : ''}
    ${unknownList.length ? `<p class="hint">上游没提供参数、已知表里也没有的有 ${unknownList.length} 个（上下文/输出显示为 —）：
      <span class="mono">${esc(unknownList.slice(0, 6).join('、'))}${unknownList.length > 6 ? ' 等' : ''}</span>
      —— 这些留空由你决定，本程序不会替你编一个数字。</p>` : ''}
    <div class="row-inline" style="margin:10px 0;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" data-sel="all">全选</button>
      <button class="btn btn-sm" data-sel="none">全不选</button>
      <button class="btn btn-sm" data-sel="known">只留有参数的</button>
      <span class="spacer" style="flex:1"></span>
      <span class="hint" data-count></span>
    </div>
    <div class="table-wrap" style="max-height:320px">
      <table class="tbl">
        <thead><tr>
          <th style="width:34px"></th><th>上游模型 ID</th><th>映射为</th>
          <th style="width:44px" title="是否支持图片输入">图片</th>
          <th style="width:88px">上下文</th><th style="width:88px">最大输出</th>
          <th style="width:78px" title="逐模型超时；— 表示用供应商级">超时(ms)</th>
        </tr></thead>
        <tbody>${cells}</tbody>
      </table>
    </div>
    <div class="row-inline" style="margin-top:10px;flex-wrap:wrap;gap:12px">
      <label class="chk"><input type="checkbox" id="mpMeasure" /> 顺便实测超时
        <span class="hint">（对每个勾选的模型发一次最小请求，会消耗极少量额度；实测值 ×4 取整，夹在 10s–120s。
          <b>每个之间会留 3.5 秒间隔</b>以免触发上游限流 —— 所以勾选的模型越多等得越久，中途可取消。）</span></label>
      <label class="chk"><input type="checkbox" id="mpReplace" checked /> 替换现有模型列表
        <span class="hint">（不勾 = 追加到现有列表后面）</span></label>
    </div>
    <div class="hint" id="mpStatus" style="margin-top:8px"></div>
  `;

  Modal.open({
    title: '一键获取全部模型',
    body,
    buttons: [
      { label: '取消', cls: 'btn-ghost' },
      {
        label: '应用到模型表',
        cls: 'btn-primary',
        // ⚠ `close: false` —— 让 applyModelPicker 自己决定关不关。
        // 默认行为是无条件 Modal.close()，于是"一个都没选"时用户看到一句提示，
        // 但**整个勾选界面已经没了** —— 一次 4MB 的目录拉取（cline 有 464 个模型）
        // 加人工勾选全部作废，只能重新拉。实测复现过。
        close: false,
        onClick: (btn) => applyModelPicker(rows, btn),
      },
    ],
    onOpen: () => {
      // 每次弹窗一个身份标记：测速是异步的，用户可能在等待期间关掉这个弹窗、又开一个新的。
      // 回填前必须确认"这个弹窗还在世"，否则会把上一轮的结果写进新弹窗的表格里
      //（实测：A 弹窗的 11111/22222 会显示在 B 弹窗里，而 B 应用后一个超时都没写进去）。
      const token = {};
      livePickerToken = token;
      const isLive = () => livePickerToken === token;
      const sync = () => {
        if (!isLive()) return;
        const n = $$('#modalBody tbody tr').filter((tr) => tr.querySelector('[data-keep]').checked).length;
        const cnt = $('#modalBody [data-count]');
        if (cnt) cnt.textContent = `已选 ${n} / ${rows.length}`;
      };
      $$('#modalBody tbody tr').forEach((tr) => {
        tr.querySelector('[data-keep]').addEventListener('change', sync);
      });
      $('#modalBody [data-sel="all"]').addEventListener('click', () => { setAll(true); sync(); });
      $('#modalBody [data-sel="none"]').addEventListener('click', () => { setAll(false); sync(); });
      $('#modalBody [data-sel="known"]').addEventListener('click', () => {
        $$('#modalBody tbody tr').forEach((tr) => {
          const m = rows[Number(tr.dataset.i)];
          if (!m) return;                       // dataset.i 越界时不要炸
          tr.querySelector('[data-keep]').checked = !!(m.contextWindow || m.maxTokens || m.vision);
        });
        sync();
      });
      function setAll(v) {
        $$('#modalBody tbody tr').forEach((tr) => { tr.querySelector('[data-keep]').checked = v; });
      }
      sync();

      // 实测超时：只对勾选的模型做，结果直接回填到表格
      $('#mpMeasure').addEventListener('change', async (e) => {
        if (!e.target.checked) return;
        const picked = rows.filter((m, i) => {
          const n = $(`#modalBody tbody tr[data-i="${i}"] [data-keep]`);
          return n && n.checked;
        });
        if (!picked.length) { e.target.checked = false; toast('没有勾选任何模型', 'warn'); return; }
        const st = $('#mpStatus');
        st.textContent = `正在实测 ${picked.length} 个模型…（串行，每个最多 40 秒）`;
        // ⚠ catch 必须有：IPC 抛错时状态栏会**永久停在"正在实测…"**，用户以为还在跑。
        let r = null;
        try {
          r = await window.lgw.gwMeasureModels(probeProvider, picked.map((m) => ({ id: m.id })));
        } catch (err) {
          if (isLive() && st) st.textContent = '测速失败：' + ((err && err.message) || err);
          return;
        }
        // 弹窗可能已经被关掉/换成新的了 —— 这时**什么都不要碰**：
        // `$('#modalBody …')` 现在指向的是新弹窗的节点，写进去就是串台。
        if (!isLive()) return;
        if (!r || !r.ok) { st.textContent = '测速失败：' + ((r && r.error) || '未知错误'); return; }
        const results = Array.isArray(r.results) ? r.results : [];
        let got = 0;
        results.forEach((x) => {
          // x 可能是 null / 缺 id —— 直接读 x.id 会在 null 上抛，把状态栏永远留在"正在实测…"
          if (!x || typeof x !== 'object') return;
          const i = rows.findIndex((m) => m.id === x.id);
          if (i < 0) return;
          const tmo = Number(x.suggestedTimeoutMs);
          if (Number.isFinite(tmo) && tmo > 0) {
            rows[i]._tmo = tmo;
            got++;
            const td = $(`#modalBody tbody tr[data-i="${i}"] [data-tmo]`);
            if (td) td.textContent = String(tmo);
          }
        });
        st.textContent = `实测完成：${got}/${picked.length} 个拿到建议超时`
          + (got < picked.length ? '；其余失败或超时，未给建议（不会用"超时"当"很慢"）' : '')
          // ⚠ 如实说出"为什么没测完"。为防封给每个模型之间加了间隔，
          // 模型多时会撞上整体时间预算而提前收尾 —— 不说清楚的话，
          // 用户会以为"全都测过了"，而实际上后面几十个还是空的。
          + (r.note ? '　' + r.note : '')
          + (r.skipped ? '（再点一次「顺便实测超时」可继续测剩下的）' : '');
        toast(`已按实测填写 ${got} 个建议超时`, got ? 'ok' : 'warn');
      });
    },
  });

  /** 把选择器里的结果写进编辑抽屉的模型表。 */
  function applyModelPicker(allRows, btn) {
    const keep = [];
    $$('#modalBody tbody tr').forEach((tr) => {
      const m = allRows[Number(tr.dataset.i)];
      // ⚠ 越界必须跳过。旧实现直接 `m.id`，一旦 DOM 行数与 rows 对不上就是 TypeError；
      // 而 keep 是"先收集后落表"，异常发生在任何写入之前 —— 于是**整次「应用」什么都没做、
      // 也没有任何提示**（与"点了没反应"同形）。
      if (!m) return;
      if (!tr.querySelector('[data-keep]').checked) return;
      const e = { up: m.id, as: m.as && m.as !== m.id ? m.as : '' };
      if (m.vision) e.vision = true;
      // 数字字段一律收敛：上游给字符串时不能原样落进配置（会让 `Number.isFinite` 判假、静默失效）
      const ctx = Number(m.contextWindow);
      const mt = Number(m.maxTokens);
      // ⚠ 超时字段的键名要**两种都认**。
      //
      // `gw:fetch-models` 返回的是 `timeoutMs`（model-meta.enrichModel 的字段名），
      // 而 `openModelPicker` 会额外挂一个 `_tmo` 供弹窗内排序/表单使用。
      // 旧实现只读 `_tmo` —— 它恰好因为 openModelPicker 挂了那个字段而"能用"，
      // 但这是**依赖调用顺序的巧合**：任何直接喂 fetched.models 的路径
      //（比如把 picker 的数据源换成别的）都会静默丢掉超时。
      // 两个都读，谁有值用谁。
      const tmo = Number(m._tmo || m.timeoutMs);
      if (Number.isFinite(ctx) && ctx > 0) e.contextWindow = ctx;
      if (Number.isFinite(mt) && mt > 0) e.maxTokens = mt;
      if (Number.isFinite(tmo) && tmo > 0) e.timeoutMs = tmo;
      // ⚠ 不把 _src / _matchedBy / _keep / _tmo 这些"界面内部字段"带进配置。
      // 上面只挑已知字段构造 `e`，所以它们天然进不去 —— 这里写一句是为了
      // 防止以后有人图省事改成 `Object.assign({}, m, …)`。
      keep.push(e);
    });
    if (!keep.length) {
      // 不关弹窗：一次 4MB 的目录拉取 + 人工勾选不该因为这一下就全丢
      toast('至少选一个模型（弹窗保留着，勾选后重试）', 'warn', 6000);
      return;
    }

    const replace = $('#mpReplace').checked;
    const tb = $('#edModelTable tbody');
    // ⚠ **先**把旧表读出来再清空 —— 「⚡一键获取」只负责"有哪些模型"，
    // 它**不知道**每个模型该用哪种上游协议（`api` 是配置里的事实，不在上游目录里）。
    // 旧实现直接按拉回来的结果重建，于是 `api` 被静默抹掉：
    // 用户点一次「一键获取」，opencode-go 的 11 个模型全部退回"跟随客户端协议"，
    // 下一次请求全部 400 `ModelProtocolUnsupported`。
    // 实测（2026-10-08）：整家供应商就是这样废掉的，且界面上看不出任何异常。
    const prevApi = new Map();
    readEditorModels().forEach((x) => {
      if (x && typeof x === 'object' && x.api) prevApi.set(x.id, x.api);
    });
    if (replace) {
      tb.innerHTML = '';
    } else if (tb.children.length === 1) {
      const only = tb.children[0];
      if (!String(only.querySelector('[data-f="up"]').value || '').trim()) only.remove();
    }
    const existing = new Set(readEditorModels().map((x) => (typeof x === 'string' ? x : x.id)));
    let added = 0;
    let carried = 0;
    keep.forEach((e) => {
      if (!replace && existing.has(e.up)) return;
      existing.add(e.up);
      // 名字没变就沿用原来的协议声明；用户仍可在表里逐行改。
      if (!e.api && prevApi.has(e.up)) { e.api = prevApi.get(e.up); carried++; }
      tb.appendChild(modelRow(e));
      added++;
    });
    updateEditorModelCount();
    Modal.close();
    toast(`已写入 ${added} 个模型`
      + (replace ? '（替换了原列表）' : `（追加；跳过 ${keep.length - added} 个已存在的）`)
      + (carried ? `，沿用原有协议声明 ${carried} 条` : '')
      + '，别忘了点「应用」', 'ok', 6000);
    btn.blur();
  }
}

function tb2rows() { return $('#edModelTable tbody').children.length; }

function readEditorModels() {
  const out = [];
  $$('#edModelTable tbody tr').forEach((tr) => {
    const up = String((tr.querySelector('[data-f="up"]') || {}).value || '').trim();
    if (!up) return;
    const as = String((tr.querySelector('[data-f="as"]') || {}).value || '').trim();
    // ⚠ 逐模型协议必须一起读回来。漏了它 = 每次「应用」都把协议声明抹掉，
    // 而按模型区分协议的上游（opencode-go）会因此整体 400（ModelProtocolUnsupported）。
    const api = String((tr.querySelector('[data-f="api"]') || {}).value || '').trim();
    const vision = !!(tr.querySelector('[data-f="vision"]') || {}).checked;
    const ctx = Number((tr.querySelector('[data-f="contextWindow"]') || {}).value || 0);
    const mt = Number((tr.querySelector('[data-f="maxTokens"]') || {}).value || 0);
    const tmo = Number((tr.querySelector('[data-f="timeoutMs"]') || {}).value || 0);
    const obj = { id: up };
    if (as && as !== up) obj.as = as;
    if (api) obj.api = api;
    if (vision) obj.vision = true;
    if (ctx > 0) obj.contextWindow = ctx;
    if (mt > 0) obj.maxTokens = mt;
    if (tmo > 0) obj.timeoutMs = Math.round(tmo);
    out.push(Object.keys(obj).length === 1 ? up : obj);
  });
  return out;
}

function updateEditorModelCount() {
  const rows = readEditorModels();
  const logical = new Set(rows.map((r) => (typeof r === 'string' ? r : (r.as || r.id))));
  $('#edModelCount').textContent = `上游 ${rows.length} 条 → 逻辑模型 ${logical.size} 个`;
}

function parsePaste(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const m = raw.split(/\s*(?:=>|->|=)\s*/);
    const up = String(m[0] || '').trim();
    const as = String(m[1] || '').trim();
    if (!up) return;
    out.push(as && as !== up ? { id: up, as } : up);
  });
  return out;
}

function wireEditor() {
  $('#edAddModel').addEventListener('click', () => {
    $('#edModelTable tbody').appendChild(modelRow({ up: '', as: '' }));
    updateEditorModelCount();
  });
  $('#edPasteToggle').addEventListener('click', () => $('#edPasteBox').classList.toggle('hidden'));
  $('#edPasteImport').addEventListener('click', () => {
    const items = parsePaste($('#edPaste').value);
    if (!items.length) { toast('没有解析到任何模型', 'warn'); return; }
    const tb = $('#edModelTable tbody');
    // 清掉唯一的空占位行
    if (tb.children.length === 1) {
      const only = tb.children[0];
      if (!String(only.querySelector('[data-f="up"]').value || '').trim()) only.remove();
    }
    const existing = new Set(readEditorModels().map((r) => (typeof r === 'string' ? r : r.id)));
    let added = 0;
    items.forEach((it) => {
      const id = typeof it === 'string' ? it : it.id;
      if (existing.has(id)) return;
      existing.add(id);
      tb.appendChild(modelRow(typeof it === 'string' ? { up: it, as: '' } : { up: it.id, as: it.as || '' }));
      added++;
    });
    $('#edPaste').value = '';
    $('#edPasteBox').classList.add('hidden');
    updateEditorModelCount();
    toast(`已导入 ${added} 条模型映射`, 'ok');
  });

  // 拉取上游模型目录：直接用当前表单里的 baseURL + Key（还没保存也能拉）
  $('#edFetchCatalog').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const old = btn.textContent;
    const url = $('#edUrl').value.trim();
    if (!url) { toast('请先填 Base URL', 'warn'); return; }
    btn.disabled = true;
    btn.textContent = '拉取中…';
    // 借道"探测"：临时把表单内容拼成一个虚拟供应商，交给主进程按同一套代理规则请求
    const tmp = {
      id: $('#edId').value.trim() || '__probe__',
      baseURL: url,
      apiKey: String($('#edKeys').value || '').split(/\r?\n/)[0].trim(),
    };
    // ⚠ catch 与 finally **都不能少**：
    //   · 没 catch → IPC 抛错时静默无反应（用户只看到按钮闪一下）
    //   · 没 finally → 抛错后按钮永久停在"拉取中…"且 disabled，点不动，只能关掉抽屉重开
    // 旧实现两者都没有，实测就是这样卡死的。
    let r;
    try {
      r = await window.lgw.gwFetchCatalog(tmp);
    } catch (e) {
      toast('拉取失败：' + ((e && e.message) || e), 'err', 8000);
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
    if (!r || !r.ok) {
      toast('拉取失败：' + ((r && r.error) || '未知错误'), 'err', 7000);
      return;
    }
    if (!Array.isArray(r.models)) { toast('上游返回的目录格式不对', 'err', 7000); return; }
    const tb = $('#edModelTable tbody');
    if (tb.children.length === 1) {
      const only = tb.children[0];
      if (!String(only.querySelector('[data-f="up"]').value || '').trim()) only.remove();
    }
    const existing = new Set(readEditorModels().map((x) => (typeof x === 'string' ? x : x.id)));
    let added = 0;
    r.models.forEach((id) => {
      if (existing.has(id)) return;
      existing.add(id);
      tb.appendChild(modelRow({ up: id, as: '' }));
      added++;
    });
    updateEditorModelCount();
    toast(`从上游目录拉取到 ${r.models.length} 个模型，新增 ${added} 条`, 'ok', 5000);
  });

  // ⚡ 一键获取全部模型：拉目录 + 自动补参数 + 自动映射短名 + 可勾选删减 + 可选实测超时
  $('#edFetchAll').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const url = $('#edUrl').value.trim();
    if (!url) { toast('请先填 Base URL', 'warn'); return; }
    const tmp = {
      id: $('#edId').value.trim() || '__probe__',
      baseURL: url,
      apiKey: String($('#edKeys').value || '').split(/\r?\n/)[0].trim(),
    };
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '拉取中…';
    let r;
    try {
      r = await window.lgw.gwFetchModels(tmp, {});
    } catch (e) {
      // 只有 finally 没有 catch 的话，IPC 抛错会变成 unhandled rejection ——
      // 用户看到按钮闪一下、什么都没发生。这与上一轮 `dup is not defined` 是同一种失败形态。
      toast('拉取失败：' + ((e && e.message) || e), 'err', 8000);
      return;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
    if (!r || !r.ok) { toast('拉取失败：' + ((r && r.error) || '未知错误'), 'err', 8000); return; }
    if (!Array.isArray(r.models)) { toast('上游返回的目录格式不对', 'err', 8000); return; }
    if (!r.models.length) { toast('上游目录是空的', 'warn'); return; }
    openModelPicker(r, tmp);
  });

  // ⚠ 以下这些都是 index.html 里的**静态**节点，接线必须放在只执行一次的 initProviders 里。
  // 旧实现在这里（wireEditor）挂监听，而 wireEditor 每次 openEditor 都会调用 ——
  // 于是每开一次抽屉就多叠一层：打开 3 次后点一次「应用」会执行 3 遍，
  // 第 1 遍正常写回，第 2、3 遍撞上唯一性校验 → 用户看到 1 条"已应用" + N 条红色"ID 已存在"。
  // 长会话里实测累积到 26 层 → 25 条错误提示。
  // 抽屉内部用 innerHTML 重建的 #ed* 节点不受影响，那些仍然在 wireEditor 里挂。
}

function applyEditor() {
  const errBox = $('#edError');
  const fail = (msg) => {
    errBox.classList.remove('hidden');
    errBox.textContent = msg;
    toast(msg, 'err', 7000);
  };
  errBox.classList.add('hidden');

  const id = $('#edId').value.trim();
  if (!id) return fail('ID 不能为空');
  if (id !== (LG.config.providers[editingIndex] || {}).id
    && LG.config.providers.some((p, i) => i !== editingIndex && p.id === id)) {
    return fail('ID 已存在：' + id + '（运行期熔断/目录/亲和状态都按 id 共享，必须唯一）');
  }
  const url = $('#edUrl').value.trim();
  if (!url) return fail('Base URL 不能为空');
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Base URL 必须是 http(s) 绝对地址');
  } catch (_) {
    return fail('Base URL 不是合法的绝对地址（要以 https:// 或 http:// 开头）');
  }

  const keys = String($('#edKeys').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const auth = $('#edAuth').value;
  // ⚠ 这些鉴权方式的凭据**不在配置里**（由本机其它程序提供），所以不能要求填 Key：
  //   · workbuddy —— 用桌面客户端凭据（authFile / 自动发现）
  //   · codex     —— 用 Codex 桌面版/CLI 已登录的 auth.json（含自动刷新）
  // 旧实现硬编码成 `auth !== 'workbuddy'`，于是选了 codex 仍被要求填 Key，
  // 而 Codex 订阅**根本没有 Key 可填** → 预设加进来的条目**永远保存不了**
  //（实测 2026-10-09：面板报「请至少填一把 API Key」）。
  // 判据必须是个集合：加新鉴权方式时同步加进来。
  const CREDENTIAL_FREE_AUTH = ['workbuddy', 'codex'];
  if (keys.length === 0 && !CREDENTIAL_FREE_AUTH.includes(auth)) {
    const accountsRaw = $('#edAccounts').value.trim();
    if (!accountsRaw) {
      return fail('请至少填一把 API Key（或选择 workbuddy / codex 鉴权，或填账户池）');
    }
  }

  // 高级字段解析
  const quirksRaw = $('#edQuirks').value.trim();
  const quirks = quirksRaw ? quirksRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
  for (const q of quirks) {
    if (!QT_KNOWN.includes(q)) return fail(`未知的兼容开关「${q}」，可用：${QT_KNOWN.join(' / ')}`);
  }

  let headers;
  const headersText = $('#edHeaders').value.trim();
  if (headersText) {
    headers = {};
    for (const line of headersText.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf(':');
      if (i <= 0) return fail('自定义请求头格式错误（应为 `Header-Name: value`）：' + t);
      headers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }

  let accounts;
  const acctText = $('#edAccounts').value.trim();
  if (acctText) {
    try {
      accounts = JSON.parse(acctText);
      if (!Array.isArray(accounts)) return fail('账户池必须是 JSON 数组');
    } catch (e) {
      return fail('账户池 JSON 解析失败：' + (e && e.message ? e.message : e));
    }
  }

  const timeoutRaw = $('#edTimeout').value.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 0;
  if (timeoutRaw && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) return fail('超时必须是正数（毫秒）');

  // 组装新条目：**保留未知字段**（用户可能在 JSON 里写了本界面没暴露的键）
  const prev = LG.config.providers[editingIndex] || {};
  const next = Object.assign({}, prev);
  next.id = id;
  next.baseURL = url;
  next.priority = Number($('#edPriority').value) || 1;
  next.enabled = $('#edEnabled').checked;

  // Key：1 把写 apiKey（兼容旧路径），≥2 把写 apiKeys（账户池轮换）
  if (keys.length === 1) {
    next.apiKey = keys[0];
    delete next.apiKeys;
  } else if (keys.length > 1) {
    next.apiKey = keys[0];
    next.apiKeys = keys;
  } else if (auth === 'workbuddy' && prev.apiKey) {
    // workbuddy 且清空了 Key：不动原来的 apiKey（可能是占位）
    next.apiKey = prev.apiKey;
    delete next.apiKeys;
  } else {
    delete next.apiKey;
    delete next.apiKeys;
  }

  next.models = readEditorModels();
  if (quirks.length) next.quirks = quirks; else delete next.quirks;
  if (headers) next.headers = headers; else delete next.headers;
  if (accounts) next.accounts = accounts; else delete next.accounts;
  if (timeoutRaw) next.timeoutMs = timeoutMs; else delete next.timeoutMs;
  const proto = $('#edProtocol').value;
  if (proto) next.protocol = proto; else delete next.protocol;
  const prof = $('#edProfile').value;
  if (prof) next.clientProfile = prof; else delete next.clientProfile;
  if (auth) next.auth = auth; else delete next.auth;
  if ($('#edDirect').checked) next.proxy = false; else {
    delete next.proxy;
    delete next.noProxy;
  }

  LG.config.providers[editingIndex] = next;
  // 用户确认了这条（若是「＋添加」建的那条，此刻才真正成为一条配置）→ 清掉待回滚标记。
  // 必须在 closeEditor() **之前**清：closeEditor 看到 -1 才不会把它删掉。
  pendingNewIndex = -1;
  markDirty('供应商 ' + id);
  closeEditor();
  LG.renders.providers();
  LG.renders.models();
  renderTopbar();
  toast('已应用到工作副本，记得点「保存并生效」', 'warn', 4200);
}

/* ==================== 新增供应商 ==================== */

function addProvider() {
  const n = (LG.config.providers || []).length + 1;
  let id = 'provider-' + n;
  let i = n;
  while (LG.config.providers.some((p) => p.id === id)) { i++; id = 'provider-' + i; }
  LG.config.providers.push({
    id,
    baseURL: '',
    apiKey: '',
    models: [],
    priority: 1,
    enabled: true,
  });
  // ⚠ **不在这里 markDirty**：这条还没被用户确认过。取消时要能干净地回滚，
  // 若此时已标脏，回滚后脏标记就与内容不符了（用户会看到一个"未保存"提示却无从保存）。
  // 标脏交给 applyEditor 成功时做 —— 那时它才真正成为一条配置。
  pendingNewIndex = LG.config.providers.length - 1;
  LG.renders.providers();
  renderTopbar();
  openEditor(pendingNewIndex);
}

/* ==================== 渠道预设（免费通道 / 订阅通道）====================
 * 来源：社区插件 dsh-our-free-model（它把每条都对着活网关直接请求核对过）。
 * 共同点：**不花你自己的钱，但也不是你的额度** —— 用的是上游给自家用户的免费池。
 *
 * 因此三条规矩：
 *   ① 默认不添加，必须用户手动选、看完说明才加；
 *   ② 界面上如实写明来源、条款归属、隐私代价与**当前实测状态**；
 *   ③ 上游随时会改规则 —— 状态字段就是干这个的，别把它写成"配好就一劳永逸"。
 *
 * `status` 取值（本机 2026-10-08 实测）：
 *   verified   本机实测可用
 *   broken     本机实测已不可用（附证据）
 *   unreachable 本机网络到不了，无法判定
 */
 // Go 端点实测走 chat/completions 的 29 个模型（2026-10-08 逐个探测得出）
// 改这里之前请先重跑一次探测 —— 上游的模型清单和各自协议都会变。
const OPENCODE_GO_CHAT_MODELS = [
  'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-flash', 'deepseek-v4.1-flash',
  'deepseek-v4-pro', 'glm-5.1', 'glm-5.2', 'glm-5.3',
  'glm-5.3-flash', 'omen-alpha', 'hy3', 'hy4-preview',
  'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'mimo-v2.5',
  'mimo-v2.6-flash', 'mimo-v2.5-pro', 'mimo-v2.6-pro', 'minimax-m2.5',
  'minimax-m3', 'space-bunny', 'longcat-2.0', 'longcat-2.5-preview-free',
  'qwen3.6-plus', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.8-flash',
  'qwen3.7-plus',
];
const OPENCODE_GO_ANTHROPIC_MODELS = ['claude-haiku-5-5', 'minimax-m2.7'];

/**
 * Codex 订阅后端的有效模型名。
 *
 * 来源：`$CODEX_HOME/models_cache.json`（官方客户端自己拉的清单，2026-10-09 实测快照）。
 * ⚠ **`gpt-5-codex` 不在这里** —— 它是 API Key 路径的模型名，用 ChatGPT 订阅调它会 400：
 *   {"detail":"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."}
 * 用户 `~/.codex/config.toml` 里默认写的正是它，所以这里必须把清单摆出来。
 */
const CODEX_SUB_MODELS = [
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-reserve',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'codex-auto-review',
];

const FREE_CHANNEL_PRESETS = [
  // ⚠ 说明字段（what / statusNote）是**渲染层硬编码常量**，不是用户或上游输入，
  // 且内容里有意写了 <b>/<code> 排版 —— 所以渲染时**不能** esc()，否则标签会原样显示成文字。
  // （旧实现只对 what 转了义、对 statusNote 没转，于是预设说明里全是 `&lt;b&gt;` 字面量。）
  // 同理，risks 数组项也是常量，直接拼进 <li>。
  {
    key: 'codex-sub',
    name: 'Codex 订阅（ChatGPT Plus/Pro）',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    apiKey: '',                       // 凭据从磁盘读，不需要 key
    status: 'verified',
    statusNote: '本机实测（2026-10-09，真实 Codex Plus 订阅）：<code>/v1/models</code> 列出 <b>10 个模型</b>；'
      + 'Anthropic 协议**非流式与流式都返回 200**，内容正确；日志零凭据泄漏。',
    what: '用你的 <b>ChatGPT 订阅</b>（Codex）当上游 —— 不消耗 OpenAI Platform 的 API Key 额度。'
      + '凭据复用官方 Codex 桌面版/CLI 已登录的 <code>auth.json</code>，'
      + '网关自动读取并在过期前 5 分钟刷新（刷新后原子写回，与官方客户端共用一份，不会互相作废）。',
    risks: [
      '<b>别填 <code>gpt-5-codex</code></b> —— 实测 400「not supported when using Codex with a ChatGPT account」。'
      + '用本预设带的这 10 个。',
      '这是<b>订阅额度</b>，计费与限流遵循你的 ChatGPT 计划，与 OpenAI Platform API Key 是两套。',
      '需要本机已登录 Codex 桌面版或 CLI（<code>$CODEX_HOME/auth.json</code> 或 <code>~/.codex/auth.json</code>）。'
      + '没登录时网关会明确报错，不会静默失败。',
      '上游 Content-Type 会<b>谎报</b> <code>application/json</code>（正文其实是 SSE）、'
      + '要求请求体带 <code>store:false</code>、且路径不能有 <code>/v1</code> —— 这三点网关都已按 codex 自动兜底。',
      '可用模型由上游随时增删 —— 上面那份清单是实测快照，不是承诺。',
    ],
    apply: (p) => {
      p.auth = 'codex';                 // ← 走官方客户端凭据（含自动刷新）
      p.protocol = 'openai-responses';  // ← Codex 后端是 Responses API
      p.models = CODEX_SUB_MODELS.slice();
    },
  },
  {
    key: 'opencode-go',
    name: 'OpenCode Go 套餐（自带 key）',
    baseURL: 'https://opencode.ai/zen/go',
    apiKey: '',
    status: 'verified',
    statusNote: '本机实测（2026-10-08，用真实 key oc_sk_…）：Go 端点带 key 返回 <b>37 个模型</b>，'
      + '逐个定协议后 <b>31 个可用</b>（29 个走 chat、2 个走 Anthropic），4 个（grok/gpt）需要 Responses 协议，'
      + '2 个（muse-spark）上游要求"训练数据同意"。',
    what: 'opencode 的 Go **订阅套餐**端点（不是充值制）。它比 Zen 端点多一个硬性要求：'
      + '<b>必须带 x-opencode-session</b>，少了直接 400 MissingSessionID —— '
      + '选本预设会自动开启 OpenCode 客户端仿真，网关按对话内容派生稳定的会话 id。',
    risks: [
      '这是<b>订阅额度</b>：能不能用取决于你的套餐状态，用完了上游会直接拒。',
      '上游按<b>会话</b>计费：网关已保证同一对话用同一会话 id（少了会被 400，抖动会被当成新会话）。',
      '<b>grok / gpt 这 4 个模型需要 Responses 协议</b>，本网关暂不支持这条协议，因此它们不在模型列表里 —— '
      + '强行加上会在选中后报 400 "Model does not support this protocol"。',
      '可用模型由上游随时增删 —— 上面那份清单是实测快照，不是承诺。',
    ],
    apply: (p) => {
      p.protocol = 'openai-chat';
      p.clientProfile = 'opencode';
      p.models = OPENCODE_GO_CHAT_MODELS.slice();
    },
  },
  {
    key: 'opencode-go-claude',
    name: 'OpenCode Go · Anthropic 类模型',
    baseURL: 'https://opencode.ai/zen/go',
    apiKey: '',
    status: 'verified',
    statusNote: '本机实测（2026-10-08）：claude-haiku-5-5 与 minimax-m2.7 走 Anthropic 协议，'
      + '该路径<b>要 x-api-key</b>（用 authorization: Bearer 会 401）—— 网关会自动按协议选对认证头。',
    what: '和上一条是同一个端点，但这两个模型只认 /messages。因此这里**不设 protocol**，'
      + '让客户端的 Anthropic 请求原样透传（网关在 Anthropic 路径上自动改用 x-api-key）。',
    risks: [
      '必须和「OpenCode Go 套餐」一起装（同一个 key）—— 单独装只会得到 401。',
      'Claude 模型在该端点上可能触发 Anthropic 的提示词缓存计费，用量请自行留意。',
    ],
    apply: (p) => {
      p.clientProfile = 'opencode';
      p.models = OPENCODE_GO_ANTHROPIC_MODELS.slice();
    },
  },
  {
    key: 'opencode-zen',
    name: 'OpenCode Zen（自带 key）',
    baseURL: 'https://opencode.ai/zen',
    apiKey: '',
    status: 'verified',
    statusNote: '本机实测（2026-10-08）：Zen 端点带 key 只可见 25 个模型，其中 8 个免费档报 '
      + '403「free tier can only be used from within OpenCode」、16 个付费档报 402「Insufficient account funds」，'
      + '<b>只有 space-bunny-free 实测可用</b>。',
    what: 'opencode 的 Zen 端点。带 key 后<b>不需要仿真头</b>，就是个普通 OpenAI 兼容供应商。',
    risks: [
      '免费档<b>大多用不了</b>：上游回 403「free tier can only be used from within OpenCode」'
        + '—— 它要求请求确实来自官方客户端，不是靠加几个头就能过的。',
      '付费档需要账户<b>有余额</b>，否则 402。',
      '认证方式必须是 <code>Authorization: Bearer &lt;key&gt;</code>；用 <code>x-api-key</code> 会 401。',
    ],
    // 实测可用的那个模型直接填好，用户拿到就是能跑的配置
    apply: (p) => { p.protocol = 'openai-chat'; p.models = ['space-bunny-free']; },
  },
  {
    key: 'kilo',
    name: 'Kilo AI 公共网关（免密免费池）',
    baseURL: 'https://api.kilo.ai/api/gateway',
    apiKey: '',
    status: 'unreachable',
    statusNote: '本机实测：直连与经代理（127.0.0.1:7890）都是连接失败（curl HTTP=000），无法判定可用性。'
      + '另外它的接口路径<b>不带 /v1</b>，而本网关会把 baseURL 规范化成带 /v1 —— '
      + '真要用需要先在「供应商」里手改地址试出正确路径。',
    what: '理论上无需任何账号或 Key，取上游 listing 里 isFree: true 的那一截。',
    risks: [
      '<b>上游在模型卡里明确声明</b>：免费池的 prompt 可能被记录并用于改进其服务 —— '
        + '不要用它跑敏感内容或正式工作。',
      '可用模型由上游随时增删，本网关不做任何保证。',
    ],
    apply: (p) => { p.protocol = 'openai-chat'; },
  },
];

const PRESET_STATUS_LABEL = {
  verified: ['✓ 本机实测可用', 'ok'],
  broken: ['✗ 本机实测已不可用', 'bad'],
  unreachable: ['? 本机无法连通，未判定', 'warn'],
};

/** 免费通道选择器。选完先看风险说明，确认后才真正插进配置。 */
function openFreeChannelPicker() {
  const rows = FREE_CHANNEL_PRESETS.map((c) => {
    const [label, cls] = PRESET_STATUS_LABEL[c.status] || PRESET_STATUS_LABEL.unreachable;
    return `<div class="preset-row">
      <div class="preset-head">
        <b>${esc(c.name)}</b>
        <span class="preset-badge ${cls}">${esc(label)}</span>
      </div>
      <div class="hint">${esc(c.baseURL)}${c.apiKey ? ' · apiKey=' + esc(c.apiKey) : ' · 无需凭据'}</div>
      <div class="hint">${c.what}</div>
      <div class="hint preset-status">${c.statusNote}</div>
      <button class="btn" data-preset="${esc(c.key)}">了解风险并添加</button>
    </div>`;
  }).join('');
  Modal.open({
    title: '渠道预设（免费通道 / 订阅通道）',
    body: `<p class="hint">这些是<b>第三方公共额度</b>，不是本项目的资源，也不是你的额度。
      添加前请读完说明 —— 要不要用、合不合规，由你判断。</p>${rows}`,
    buttons: [{ label: '关闭', cls: 'btn-ghost' }],
    // ⚠ Modal.open 的 onOpen() **不传参数**，内容填在 #modalBody 里（见 core.js）。
    // 写成 (root) => root.querySelectorAll(...) 会直接 TypeError。
    onOpen: () => {
      document.querySelectorAll('#modalBody [data-preset]').forEach((b) => {
        b.addEventListener('click', () => {
          const c = FREE_CHANNEL_PRESETS.find((x) => x.key === b.dataset.preset);
          if (c) confirmAddPreset(c);
        });
      });
    },
  });
}

/** 加之前的最后一道确认：把该通道的风险逐条摆出来，不做默认勾选。 */
function confirmAddPreset(c) {
  const [label] = PRESET_STATUS_LABEL[c.status] || PRESET_STATUS_LABEL.unreachable;
  const items = c.risks.map((r) => `<li>${r}</li>`).join('');
  Modal.open({
    title: '添加前请确认：' + c.name,
    body: `<p><b>${esc(label)}</b></p>
      <p class="hint">${c.statusNote}</p>
      <p>这条通道的性质：</p><ul class="preset-risks">${items}</ul>
      <p class="hint">添加后它只是一条普通供应商配置，可以随时改地址、换 key 或删掉。
      建议添加后立刻用「测试全部连通性」亲自验一遍。</p>`,
    buttons: [
      { label: '取消', cls: 'btn-ghost' },
      {
        label: '我已了解，添加',
        cls: 'btn-primary',
        onClick: () => {
          const n = (LG.config.providers || []).length + 1;
          let i = n;
          let id = c.key;
          while (LG.config.providers.some((p) => p.id === id)) { i++; id = c.key + '-' + i; }
          const p = {
            id,
            baseURL: c.baseURL,
            apiKey: c.apiKey,
            models: [],
            priority: 1,
            enabled: true,
          };
          if (typeof c.apply === 'function') c.apply(p);
          LG.config.providers.push(p);
          markDirty('添加渠道 ' + c.name);
          LG.renders.providers();
          renderTopbar();
          openEditor(LG.config.providers.length - 1);
        },
      },
    ],
  });
}

/* ==================== 初始化 ==================== */

/** 删除当前编辑中的供应商（含确认框）。被 initProviders 里的一次性监听器调用。 */
function deleteEditingProvider() {
  const p = LG.config.providers[editingIndex];
  Modal.open({
    title: '删除供应商',
    body: `<p>确定删除供应商 <b>${esc(p && p.id)}</b>？</p><p class="hint">这只是删除工作副本里的一项，点「保存并生效」之后才真正生效。</p>`,
    buttons: [
      { label: '取消', cls: 'btn-ghost' },
      {
        label: '删除',
        cls: 'btn-danger',
        onClick: () => {
          LG.config.providers.splice(editingIndex, 1);
          pendingNewIndex = -1;      // 已经删掉了，别再让 closeEditor 回滚一次
          markDirty('删除供应商');
          closeEditor();
          LG.renders.providers();
          LG.renders.models();
          renderTopbar();
        },
      },
    ],
  });
}

LG.initProviders = function initProviders() {
  $('#pvSearch').addEventListener('input', () => LG.renders.providers());
  $('#btnAddProvider').addEventListener('click', addProvider);
  $('#btnFreeChannel').addEventListener('click', openFreeChannelPicker);
  $('#btnTestAll').addEventListener('click', testAll);

  // 编辑抽屉的**静态**外壳按钮：只在这里挂一次（见 wireEditor 末尾的说明）。
  $('#btnEditorApply').addEventListener('click', applyEditor);
  $('#btnEditorCancel').addEventListener('click', closeEditor);
  $('#btnEditorClose').addEventListener('click', closeEditor);
  $('#editorMask').addEventListener('click', closeEditor);
  $('#btnEditorDelete').addEventListener('click', deleteEditingProvider);
};
