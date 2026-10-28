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
  // 模型级冷却（规则 3）：配置里没有就显示空 —— 空 = 用引擎内置默认（3 次 / 30 分钟）
  const brk = (c.breaker && typeof c.breaker === 'object') ? c.breaker : {};
  $('#stBrkThreshold').value = brk.threshold == null ? '' : brk.threshold;
  $('#stBrkCooldownMin').value = brk.cooldownMs == null ? '' : Math.round(brk.cooldownMs / 60_000);
  // 工具裁剪：**缺省即关闭**（引擎侧 DEFAULT_MAX_TOOLS = 0，`maxTools` 不存在 = 不裁剪）。
  // 判据必须是 `> 0` 而不是 `!= null`：配置里写成 0 / 负数 / 字符串数字，引擎都会当成关闭
  // （`Number.isFinite(raw) && raw > 0`），界面若显示成"已开启"就会骗人。
  const mtRaw = Number(c.maxTools);
  const mtOn = Number.isFinite(mtRaw) && mtRaw > 0;
  $('#stMaxToolsOn').checked = mtOn;
  $('#stMaxTools').value = mtOn ? String(Math.floor(mtRaw)) : '';
  // 关闭时把上限框置灰，避免"填了数字却没生效"的困惑
  $('#stMaxTools').disabled = !mtOn;

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

  // 模型级冷却（规则 3）：留空 = 用引擎内置默认 → **把键删掉**，而不是写一份默认值。
  // 写默认值会让"我没改过"变成"显式覆盖成 3/30"，日后我们调整内置默认就影响不到他。
  const brkKeys = (c.breaker && typeof c.breaker === 'object') ? Object.assign({}, c.breaker) : {};
  const brkTh = String($('#stBrkThreshold').value || '').trim();
  const brkCd = String($('#stBrkCooldownMin').value || '').trim();
  if (brkTh) brkKeys.threshold = Number(brkTh); else delete brkKeys.threshold;
  // ⚠ 冷却时长按"分钟"展示，就**不是无损往返**：配置里写 90000ms（合法值，下限 1000），
  // 界面显示 2，用户**只改了一下端口**、这两个框一动没动，applyChange 也会走这里 →
  // 写回 2×60000 = 120000 → 90 秒悄悄变成 2 分钟，界面无提示。
  // 所以：输入框里的分钟数与"原值量化出来的分钟数"相同，就**原样保留毫秒值**，
  // 判定"用户到底改没改"要跟**量化后的原值**比，而不是跟原值比。
  if (brkCd) {
    const min = Number(brkCd);
    const origMs = Number((c.breaker && c.breaker.cooldownMs) || 0);
    const shownOrig = origMs ? Math.round(origMs / 60_000) : null;
    brkKeys.cooldownMs = (shownOrig !== null && shownOrig === min) ? origMs : Math.round(min * 60_000);
  } else {
    delete brkKeys.cooldownMs;
  }
  if (Object.keys(brkKeys).length) set('breaker', brkKeys);
  else if (c.breaker !== undefined) { delete c.breaker; changed = true; }

  // 工具裁剪（默认关闭）：关掉时**删键**而不是写 0。
  // 写 0 与"没设过"在引擎里等价，但导出的配置会留下 `"maxTools": 0`，
  // 日后调整默认值就影响不到他 —— 与上面 breaker 的处理保持一致。
  // ⚠ 漏了这段的后果不是"多个提示"，而是：用户在界面关掉开关 → 配置里仍留 128 →
  // 重启后引擎照样裁剪，界面显示关闭、实际开启，全程无提示。
  if ($('#stMaxToolsOn').checked) {
    const raw = String($('#stMaxTools').value || '').trim();
    const n = raw ? Number(raw) : 128;              // 留空 = 128（与输入框 placeholder 一致）
    set('maxTools', Number.isFinite(n) && n > 0 ? Math.floor(n) : 128);
  } else if (c.maxTools !== undefined) {
    delete c.maxTools;
    changed = true;
  }
  return changed;
}

/** 只拦真正会坏事的情况：端口非法、代理地址不是 http(s)、冷却参数超范围。 */
function validateSettingsInput() {
  const port = Number($('#stPort').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口必须是 1-65535 的整数';
  const url = $('#stProxyUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) return '代理地址必须以 http:// 或 https:// 开头';
  // 模型级冷却（规则 3）：留空合法（= 用内置默认），但填了就必须在范围内 ——
  // 0 次/0 分钟等于"关掉冷却"（用户会以为网关坏了），超大值等于永久下架。
  const th = String($('#stBrkThreshold').value || '').trim();
  if (th && (!/^\d+$/.test(th) || Number(th) < 1 || Number(th) > 100)) {
    return '「模型级冷却」的失败次数必须是 1–100 的整数（留空 = 默认 3 次）';
  }
  const cd = String($('#stBrkCooldownMin').value || '').trim();
  if (cd && (!/^\d+$/.test(cd) || Number(cd) < 1 || Number(cd) > 1440)) {
    return '「冷却时长」必须是 1–1440 分钟（留空 = 默认 30 分钟）';
  }
  // 工具裁剪：只有开关打开时才校验上限。留空合法（= 128）。
  // 上限卡 2000：再大的数字没有任何实际意义（真实客户端最多几百个工具），
  // 而超大的值等于"裁剪形同虚设"，不如让用户直接关掉开关。
  if ($('#stMaxToolsOn').checked) {
    const mt = String($('#stMaxTools').value || '').trim();
    if (mt && (!/^\d+$/.test(mt) || Number(mt) < 1 || Number(mt) > 2000)) {
      return '「工具裁剪上限」必须是 1–2000 的整数（留空 = 128）';
    }
  }
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
  // ⚠ `stBrkThreshold` / `stBrkCooldownMin`（模型级冷却两个框）**必须**在这张表里。
  // 漏了它们的后果不是"少个提示"，而是：改完不标脏 → 顶栏不出现"有未保存的更改" →
  // 点「保存并生效」写回去的还是旧值 → **界面显示 3、实际生效 90**，全程无任何提示。
  // （2026-10-14 审计发现：这是我上一个版本引入这两个框时漏掉的接线。）
  ['stRouting', 'stProfile', 'stProxyEnabled', 'stProxyUrl', 'stNoProxy', 'stForceProxy',
    'stBrkThreshold', 'stBrkCooldownMin', 'stMaxTools'].forEach((id) => {
      $('#' + id).addEventListener('change', () => applyChange('网关设置'));
    });
  // 工具裁剪开关单独接：它还要联动"上限输入框是否可编辑"，所以改完要重画一次设置页。
  // 重画是安全的 —— applyChange 已经先把值写进 LG.config，重画读的就是刚写进去的值。
  $('#stMaxToolsOn').addEventListener('change', () => {
    applyChange('工具裁剪');
    LG.renders.settings();
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
