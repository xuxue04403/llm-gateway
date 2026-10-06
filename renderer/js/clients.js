/* clients.js — 一键写入各客户端配置（预览 → 确认 → 写入 → 可恢复） */
'use strict';

LG.clientOptions = LG.clientOptions || {};

// iFlow CLI 已于 2026-04 停止服务（官方 2026-03-20 停止维护、04-17 关闭），
// 故不再作为写入目标。这里不保留它的样式与说明 —— 目标清单由主进程的
// writers.list() 提供，渲染层只按 id 查样式，多的键是无害的，但留着会误导。
const CLIENT_STYLE = {
  dsh: { color: '#2f5bd7', short: 'D' },
  'claude-code': { color: '#d97757', short: 'C' },
  codex: { color: '#10a37f', short: 'X' },
  opencode: { color: '#a855f7', short: 'O' },
  envscript: { color: '#64748b', short: '⌘' },
};

const CLIENT_DESC = {
  dsh: '把网关注册为 dsh 的 gateway 提供商（写 <code>~/.dsh/settings.yaml</code> 与凭据）。协议跟随「设置 → 客户端仿真」。',
  'claude-code': '写 <code>~/.claude/settings.json</code> 的 env 段。baseURL <b>不带 /v1</b>。',
  codex: '写 <code>~/.codex/config.toml</code>。baseURL <b>要带 /v1</b>；只用 Responses 协议。',
  opencode: '写 <code>~/.config/opencode/opencode.json</code>，新增一个 openai-compatible provider。',
  envscript: '生成环境变量脚本与端点速查，覆盖 Aider / Continue / Cline / Roo / Chatbox / Qoder CLI 等一切客户端。',
};

function clientOptions(id) {
  if (!LG.clientOptions[id]) LG.clientOptions[id] = {};
  return LG.clientOptions[id];
}

function modelSelectHtml(id, current) {
  const names = modelNames();
  if (names.length === 0) return '<span class="hint">网关还没有可用模型</span>';
  const opts = names.map((n) => `<option value="${attr(n)}" ${n === current ? 'selected' : ''}>${esc(n)}</option>`);
  return `<select data-opt="${attr(id)}">${opts.join('')}</select>`;
}

LG.renders.clients = function renderClients() {
  const grid = $('#clientGrid');
  if (!LG.clientDetect.length) {
    grid.innerHTML = '<div class="empty">正在检测…</div>';
    return;
  }
  const names = modelNames();
  const def = names[0] || '';
  // 选择是**有状态**的（存在 LG.clientOptions 里）。模型被改名/删除后必须跟着失效，
  // 否则会一直拿着旧名字去写入 —— 前端 select 因为没有匹配项会显示第一项，
  // 而 LG.clientOptions 里仍是旧值，用户看到的和实际写出去的就不一样了（实测确认）。
  const fixModel = (v) => {
    if (names.length === 0) return v || '';
    return names.includes(v) ? v : def;
  };

  grid.innerHTML = LG.clientDetect.map((t) => {
    const st = CLIENT_STYLE[t.id] || { color: '#475569', short: '?' };
    const o = clientOptions(t.id);
    o.model = fixModel(o.model);
    o.smallModel = fixModel(o.smallModel);
    if (!o.model && def) o.model = def;
    if (!o.smallModel && def) o.smallModel = def;
    if (o.wireApi === undefined) o.wireApi = 'responses';
    if (o.setDefaultModel === undefined) o.setDefaultModel = true;
    if (o.authMode === undefined) o.authMode = 'authJson';

    let opts = '';
    if (t.id === 'dsh') {
      // dsh 与其它客户端最不同的一点：它的线协议不是固定的，而是**跟随全局「客户端仿真」**。
      // 不把"实际会写成什么"显示出来，用户根本无从判断自己会得到 anthropic 还是 openai。
      const w = t.wire || {};
      opts = `<div class="c-opts">
        <div class="line"><span style="width:74px">将写入</span>
          <span class="mono">${esc(w.api || '（未知）')}</span>
          <span class="tag sm info">${esc(w.baseURL || '')}</span>
        </div>
        <div class="hint">dsh 的线协议由网关配置的 <b>clientProfile</b>（设置 → 客户端仿真）决定：
          <code>claude</code> → <code>anthropic-messages</code>（baseURL 不带 /v1）；
          其余/关闭 → <code>openai-completions</code>（baseURL 带 /v1）。
          改完仿真设置要<b>先保存</b>、再写入 dsh。</div>
      </div>`;
    } else if (t.id === 'claude-code') {
      opts = `<div class="c-opts">
        <div class="line"><span style="width:74px">主模型</span>${modelSelectHtml('model', o.model)}</div>
        <div class="line"><span style="width:74px">小快模型</span>${modelSelectHtml('smallModel', o.smallModel)}</div>
        <div class="line"><label class="chk"><input type="checkbox" data-opt="setDefaultModel" ${o.setDefaultModel ? 'checked' : ''} /> 同时改写模型别名（含顶层 model）</label></div>
        <div class="hint">不改写的话，Claude Code 仍会去请求 opus/sonnet/haiku 与 <code>opus[1m]</code> 这类厂商别名，而网关没有这些名字。</div>
      </div>`;
    } else if (t.id === 'codex') {
      opts = `<div class="c-opts">
        <div class="line"><span style="width:74px">模型</span>${modelSelectHtml('model', o.model)}</div>
        <div class="line"><span style="width:74px">线协议</span>
          <select data-opt="wireApi">
            <option value="responses" ${o.wireApi === 'responses' ? 'selected' : ''}>responses（当前唯一受支持）</option>
            <option value="chat" ${o.wireApi === 'chat' ? 'selected' : ''}>chat（老版本 Codex 兼容）</option>
          </select>
        </div>
        <div class="line"><span style="width:74px">凭据方式</span>
          <select data-opt="authMode">
            <option value="authJson" ${o.authMode === 'authJson' ? 'selected' : ''}>写 auth.json（默认）</option>
            <option value="bearer" ${o.authMode === 'bearer' ? 'selected' : ''}>experimental_bearer_token（写进 config.toml）</option>
            <option value="envKey" ${o.authMode === 'envKey' ? 'selected' : ''}>env_key（用环境变量，不落盘）</option>
          </select>
        </div>
      </div>`;
    } else if (t.id === 'opencode') {
      opts = `<div class="c-opts">
        <div class="line"><span style="width:74px">模型</span>${modelSelectHtml('model', o.model)}</div>
      </div>`;
    }

    return `<div class="client ${t.installed ? 'installed' : ''}" data-id="${attr(t.id)}">
      <div class="c-head">
        <span class="c-icon" style="background:${st.color}">${esc(st.short)}</span>
        <b>${esc(t.name || t.id)}</b>
        <span class="spacer"></span>
        ${t.baseUrlHint ? `<span class="tag sm info" title="写入的 baseURL 形态">${esc(t.baseUrlHint)}</span>` : ''}
        <span class="tag ${t.installed ? 'ok' : ''}">${t.installed ? '检测到' : '未检测到'}</span>
      </div>
      <div class="c-body">
        <div>${CLIENT_DESC[t.id] || ''}</div>
        <ul>${(t.evidence || []).slice(0, 4).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
        ${(t.configPaths || []).length ? `<div class="path">${(t.configPaths || []).map((p) => esc(p)).join('<br />')}</div>` : ''}
      </div>
      ${opts}
      <div class="c-actions">
        <button class="btn btn-sm" data-act="preview">预览</button>
        <button class="btn btn-sm btn-primary" data-act="apply">写入</button>
        <button class="btn btn-sm btn-ghost" data-act="restore">恢复备份</button>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.client').forEach((card) => {
    const id = card.dataset.id;
    const o = clientOptions(id);
    card.querySelectorAll('[data-opt]').forEach((n) => {
      const k = n.dataset.opt;
      const handler = () => {
        o[k] = (n.type === 'checkbox') ? n.checked : n.value;
      };
      n.addEventListener('change', handler);
      if (n.tagName === 'SELECT') n.addEventListener('change', handler);
    });
    card.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'preview') return doPreview(id);
        if (act === 'apply') return doApply(id);
        return doRestore(id);
      });
    });
  });
};

/* ---------------- 预览 ---------------- */

function diffHtml(file) {
  const before = file.before == null ? '' : String(file.before);
  const after = file.after == null ? '' : String(file.after);
  if (before === after) {
    return '<div class="hint" style="padding:6px 12px;">内容无变化</div>';
  }
  // 逐行对比（不追求 LCS，够看清增删即可）
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const setA = new Set(a);
  const setB = new Set(b);
  const lines = [];
  b.forEach((l) => { if (!setA.has(l)) lines.push({ op: 'add', l }); });
  a.forEach((l) => { if (!setB.has(l)) lines.push({ op: 'del', l }); });
  if (lines.length === 0) {
    // 行集合相同但顺序/重复不同
    return '<div class="hint" style="padding:6px 12px;">内容有顺序或重复行差异（哈希不同）</div>';
  }
  return '<div class="diffbox">' + lines.slice(0, 400).map((x) => `<div class="l ${x.op}">${x.op === 'add' ? '+ ' : '- '}${esc(x.l)}</div>`).join('') + '</div>';
}

/**
 * 各写入器读的都是**磁盘上的** gateway.config.json（dsh 的写入更是交给引擎子进程执行的）。
 * 因此界面里若有未保存的改动，写出去的模型清单会是旧的 —— 必须明确提示，不能让用户以为
 * 自己刚改的供应商已经生效了。
 */
function dirtyWarningHtml() {
  if (!LG.dirty) return '';
  return `<div class="warnbox"><b>配置有未保存的更改。</b>
    写入客户端时读的是<b>磁盘上已保存的配置</b>，你刚改的供应商/模型不会体现在这次写入里。
    建议先点顶部「保存并生效 (Ctrl+S)」再写入。</div>`;
}

async function doPreview(id) {
  const r = await window.lgw.writePreview(id, clientOptions(id));
  if (!r || !r.ok) {
    toast('预览失败：' + ((r && r.errors || []).join('；') || '未知错误'), 'err', 8000);
    return;
  }
  const guards = (r.guard || []).length
    ? `<div class="guard"><b>写入前必须先解决：</b><ul>${r.guard.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '';
  const warns = (r.warnings || []).length
    ? `<div class="warnbox"><b>请注意：</b><ul>${r.warnings.map((g) => `<li>${esc(g)}</li>`).join('')}</ul></div>` : '';

  const files = (r.files || []).map((f) => `
    <div class="difffile">
      <div class="fhead">
        <span class="tag ${f.action === 'create' ? 'ok' : (f.action === 'modify' ? 'info' : 'warn')}">${esc(f.action)}</span>
        <span class="fpath">${esc(f.path)}</span>
        <button class="btn btn-sm btn-ghost" data-open="${attr(f.path)}">打开所在目录</button>
      </div>
      ${f.note ? `<div class="hint" style="margin-bottom:6px;">${esc(f.note)}</div>` : ''}
      ${diffHtml(f)}
    </div>`).join('');

  Modal.open({
    title: '写入预览 · ' + (r.name || id),
    body: `${dirtyWarningHtml()}${guards}${warns}
      <p class="hint">${esc(r.summary || '')}${r.baseUrl ? ' · baseURL <code>' + esc(r.baseUrl) + '</code>' : ''}</p>
      ${files}
      <p class="hint">密钥已打码显示。写入时会在同目录留下 <code>.bak-llmgateway</code> 备份，可用「恢复备份」一键还原。</p>`,
    buttons: [
      { label: '关闭', cls: 'btn-ghost' },
      {
        label: (r.guard || []).length ? '仍有问题，不能写入' : '确认写入',
        cls: 'btn-primary',
        onClick: () => { if (!(r.guard || []).length) doApply(id, true); },
      },
    ],
    onOpen: () => {
      $$('#modalBody [data-open]').forEach((b) => {
        b.addEventListener('click', () => window.lgw.openPath(b.dataset.open));
      });
    },
  });
}

/* ---------------- 写入 ---------------- */

async function doApply(id, skipConfirm) {
  const t = LG.clientDetect.find((x) => x.id === id) || { name: id };
  if (!skipConfirm) {
    // 所有写入器读的都是**磁盘上的** gateway.config.json（dsh 更极端：写入整个交给引擎子进程）。
    // 所以有未保存改动时，给用户一个"先保存再写入"的明确选项，而不是默默用旧配置写出去。
    const choice = await new Promise((resolve) => {
      Modal.open({
        title: '确认写入 · ' + (t.name || id),
        body: `${dirtyWarningHtml()}
          <p>即将把本网关写入 <b>${esc(t.name || id)}</b> 的配置。</p>
          <p class="hint">写入前会自动备份原文件。若不确定会改什么，请先点「预览」。</p>`,
        buttons: [
          { label: '取消', cls: 'btn-ghost', onClick: () => resolve('cancel') },
        ].concat(LG.dirty ? [
          { label: '先保存配置，再写入', cls: 'btn-primary', onClick: () => resolve('save') },
          { label: '用已保存的配置写入', cls: '', onClick: () => resolve('go') },
        ] : [
          { label: '确认写入', cls: 'btn-primary', onClick: () => resolve('go') },
        ]),
      });
    });
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const saved = await saveConfig();
      if (!saved) return;
      // 保存后配置已落盘（期间可能重启过网关），继续走写入
    }
  }

  toast('正在写入 ' + (t.name || id) + ' …', '', 2500);
  const r = await window.lgw.writeApply(id, clientOptions(id));
  if (!r || !r.ok) {
    Modal.open({
      title: '写入失败 · ' + (t.name || id),
      body: `<div class="guard"><ul>${(r && r.errors || ['未知错误']).map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>
        ${r && r.output ? `<pre class="log" style="max-height:220px;">${esc(r.output)}</pre>` : ''}`,
      buttons: [{ label: '知道了', cls: 'btn-primary' }],
    });
    return;
  }
  Modal.open({
    title: '写入成功 · ' + (t.name || id),
    body: `<div class="warnbox" style="background:#10261a;border-color:#1f6b3d;color:#8ff0b4;">已写入：<br />${(r.files || []).map((f) => '<code>' + esc(f) + '</code>').join('<br />')}</div>
      ${(r.backups || []).length ? `<p class="hint">备份：${(r.backups || []).map((f) => '<code>' + esc(f) + '</code>').join('、')}</p>` : ''}
      ${(r.nextSteps || []).length ? `<p><b>接下来：</b></p><ul class="help-list">${r.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${r.output ? `<pre class="log" style="max-height:200px;">${esc(r.output)}</pre>` : ''}`,
    buttons: [{ label: '完成', cls: 'btn-primary' }],
  });
  toast('已写入 ' + (t.name || id), 'ok');
  redetectClients();
}

/* ---------------- 恢复 ---------------- */

async function doRestore(id) {
  const t = LG.clientDetect.find((x) => x.id === id) || { name: id };
  const ok = await new Promise((resolve) => {
    Modal.open({
      title: '恢复备份',
      body: `<p>用本程序留下的备份覆盖 <b>${esc(t.name || id)}</b> 的配置文件？</p>
        <p class="hint">当前内容会先另存为 <code>.bak-llmgateway-before-restore</code>，不会丢。</p>`,
      buttons: [
        { label: '取消', cls: 'btn-ghost', onClick: () => resolve(false) },
        { label: '恢复', cls: 'btn-primary', onClick: () => resolve(true) },
      ],
    });
  });
  if (!ok) return;
  const r = await window.lgw.writeRestore(id);
  if (r && r.ok) {
    toast('已恢复：' + ((r.results || []).map((x) => x.file).join('、') || '无变化'), 'ok', 5000);
  } else {
    toast('恢复失败：' + ((r && r.errors || []).join('；') || '未知错误'), 'err', 8000);
  }
  redetectClients();
}

/* ---------------- 检测 ---------------- */

async function redetectClients() {
  const r = await window.lgw.writeDetect();
  LG.clientDetect = (r && r.targets) || [];
  LG.renders.clients();
}

LG.initClients = function initClients() {
  $('#btnRedetect').addEventListener('click', () => { redetectClients(); toast('已重新检测', 'ok', 1500); });
  LG.renders.clients();
};
