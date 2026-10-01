/* settings.js — 设置页（网关参数、代理、应用偏好、配置文件） */
'use strict';

LG.renders.settings = function renderSettings() {
  if (!LG.config) return;
  const c = LG.config;
  $('#stPort').value = c.port == null ? 3091 : c.port;
  $('#stRouting').value = c.routing === 'round-robin' ? 'round-robin' : 'failover';
  $('#stProfile').value = c.clientProfile || '';
  const px = (c.proxy && typeof c.proxy === 'object') ? c.proxy : {};
  $('#stProxyEnabled').checked = !!px.enabled;
  $('#stProxyUrl').value = px.url || '';
  $('#stNoProxy').value = Array.isArray(px.noProxy) ? px.noProxy.join(', ') : (px.noProxy || '');
  $('#stForceProxy').value = Array.isArray(px.forceProxy) ? px.forceProxy.join(', ') : (px.forceProxy || '');

  const st = LG.state;
  if (st) {
    $('#stAutoGw').checked = st.gateway.autoStart !== false;
    $('#stMinTray').checked = st.gateway.minimizeToTray !== false;
    $('#stAutoApp').checked = !!st.gateway.autoStartApp;
    $('#stDevTools').checked = !!st.settings.openDevTools;

    $('#cfgPaths').innerHTML = [
      ['数据目录', st.dataDir],
      ['网关配置', st.gateway.configPath],
      ['网关日志', st.dataDir + '\\logs\\gateway.log'],
      ['应用日志', st.dataDir + '\\logs\\app.log'],
    ].map(([k, v]) => `<div class="kv" data-copy="${attr(v)}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="copy">复制</span></div>`).join('');
    $$('#cfgPaths .kv').forEach((n) => n.addEventListener('click', () => copy(n.dataset.copy)));
  }
};

/** 把 UI 上的值写回配置工作副本（返回是否发生变化）。 */
function readSettingsInto() {
  const c = LG.config;
  let changed = false;
  const set = (k, v) => {
    const same = JSON.stringify(c[k]) === JSON.stringify(v);
    if (!same) { c[k] = v; changed = true; }
  };
  set('port', Number($('#stPort').value));
  set('routing', $('#stRouting').value === 'round-robin' ? 'round-robin' : 'failover');
  const prof = $('#stProfile').value;
  if (prof) set('clientProfile', prof); else if (c.clientProfile !== undefined) { delete c.clientProfile; changed = true; }

  const listOf = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  const proxy = { enabled: $('#stProxyEnabled').checked };
  const url = $('#stProxyUrl').value.trim();
  const noProxy = listOf($('#stNoProxy').value);
  const forceProxy = listOf($('#stForceProxy').value);
  if (url) proxy.url = url;
  if (noProxy.length) proxy.noProxy = noProxy;
  if (forceProxy.length) proxy.forceProxy = forceProxy;
  set('proxy', proxy);
  return changed;
}

/** 只拦真正会坏事的情况：端口非法、代理地址不是 http(s)。 */
function validateSettingsInput() {
  const port = Number($('#stPort').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口必须是 1-65535 的整数';
  const url = $('#stProxyUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) return '代理地址必须以 http:// 或 https:// 开头';
  return '';
}

/** 让用户从磁盘上挑一份 gateway.config.json 导入（自动探测找不到时的兜底）。 */
async function pickImportFile() {
  const r = await window.lgw.cfgImportFile();
  if (r && r.ok) {
    setConfigFromText(r.text);
    renderAll();
    toast('已从文件导入：' + r.from, 'ok', 6000);
  } else if (r && !r.canceled) {
    toast('导入失败：' + (r.error || '未知错误'), 'err', 8000);
  }
}

LG.initSettings = function initSettings() {
  const applyChange = (label) => {
    const err = validateSettingsInput();
    if (err) { toast(err, 'err', 8000); LG.renders.settings(); return; }
    readSettingsInto();
    markDirty(label);
    LG.renders.dashboard();
    if ($('#stProxyEnabled').checked && !$('#stProxyUrl').value.trim()) {
      toast('代理已启用但没填地址 —— 网关会退回自动探测本机代理', 'warn', 6000);
    }
  };

  // 网关参数：改动即标脏（点「保存并生效」才落盘）
  ['stRouting', 'stProfile', 'stProxyEnabled', 'stProxyUrl', 'stNoProxy', 'stForceProxy'].forEach((id) => {
    $('#' + id).addEventListener('change', () => applyChange('网关设置'));
  });
  $('#stPort').addEventListener('change', () => applyChange('端口 ' + $('#stPort').value));

  // 应用偏好：直接落盘（与网关配置无关）
  const bindApp = (id, key) => {
    $('#' + id).addEventListener('change', async () => {
      const node = $('#' + id);
      const patch = {};
      patch[key] = node.checked;
      // ⚠ 必须看返回值。旧实现 `await saveSettings(patch); toast('已保存')` 无视结果 ——
      // 写盘失败（文件只读、磁盘满）时这四项开关全部**假成功**：勾选框看着是勾上的，
      // 重启程序就变回去，用户完全找不到原因。
      let r = null;
      try {
        r = await window.lgw.saveSettings(patch);
      } catch (e) {
        node.checked = !node.checked;                  // 回滚勾选框
        toast('保存失败：' + ((e && e.message) || e), 'err', 8000);
        return;
      }
      if (!r || !r.ok) {
        node.checked = !node.checked;
        toast('保存失败：' + ((r && r.error) || '未知错误'), 'err', 8000);
        return;
      }
      toast('已保存应用设置', 'ok', 1600);
    });
  };
  bindApp('stAutoGw', 'autoStartGateway');
  bindApp('stMinTray', 'minimizeToTray');
  bindApp('stAutoApp', 'autoStartApp');
  bindApp('stDevTools', 'openDevTools');

  // 导入 / 导出 / 原始 JSON
  $('#btnImportCfg').addEventListener('click', async () => {
    const r = await window.lgw.cfgImport();
    if (r && r.ok) {
      setConfigFromText(r.text);
      renderAll();
      toast(`已从既有安装导入配置（来源：${r.from}）`, 'ok', 6000);
      return;
    }
    // 自动找不到时，直接请用户指路 —— 绿色版被复制到别处时这是唯一的办法
    toast('自动未找到可导入的配置：' + ((r && r.reason) || '未找到') + '，请选择文件…', 'warn', 5000);
    pickImportFile();
  });
  $('#btnImportFile').addEventListener('click', () => pickImportFile());
  $('#btnExportCfg').addEventListener('click', async () => {
    const r = await window.lgw.cfgExport('gateway.config.json');
    if (r && r.ok) toast('已导出到 ' + r.path, 'ok', 5000);
    else if (r && !r.canceled) toast('导出失败：' + (r.error || ''), 'err');
  });
  $('#btnRawJson').addEventListener('click', () => {
    const box = $('#rawJsonBox');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      $('#rawJson').value = configText();
      $('#rawHint').textContent = '';
    }
  });
  $('#btnRawReload').addEventListener('click', () => {
    $('#rawJson').value = configText();
    $('#rawHint').textContent = '已还原为当前工作副本';
  });
  $('#btnRawApply').addEventListener('click', async () => {
    const text = $('#rawJson').value;
    const v = await window.lgw.gwValidate(text);
    if (!v.ok) {
      $('#rawHint').innerHTML = '<span style="color:#ff9c9c">' + esc(v.error) + '</span>';
      return;
    }
    setConfigFromText(text);
    markDirty('高级 JSON 编辑');
    $('#rawHint').innerHTML = '<span style="color:#8ff0b4">校验通过，已应用到工作副本</span>';
    LG.renders.settings();
    LG.renders.providers();
    LG.renders.models();
    renderTopbar();
    toast('已应用到工作副本，点顶部「保存并生效」落盘', 'warn', 5000);
  });
};
