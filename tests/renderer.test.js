// tests/renderer.test.js — 渲染层（界面）回归
//
// 为什么单独有这么一套：界面代码此前**零测试覆盖**，而用户能直接感知的 bug 恰恰都在这里。
// 实例：`openModelPicker` 里把每行的布尔 `dup` 当数组用了（应为 `dups`），
// 于是模板字符串在 `Modal.open` 之前求值时就抛 ReferenceError ——
// 用户看到的是"点了『一键获取全部模型』没反应"，而主进程日志里只有一行
// `Uncaught (in promise) ReferenceError: dup is not defined`。
// 那一行是主进程的 console-message 处理器记下来的 —— 如果没有它，这个 bug 只能靠猜。
//
// 手法：用一个最小 DOM 桩，把**真实的** renderer/js/*.js 放进 vm 里执行。
// 不是"读代码找问题"，而是真跑。桩只实现被用到的那些 DOM 能力。
//
// 运行：node tests/renderer.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { t, run } = require('./_harness');

const RJ = path.join(__dirname, '..', 'renderer', 'js');
const modelMeta = require('../src/model-meta');

/* ================================================================
 * 最小 DOM 桩
 * ================================================================ */

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function makeEl(tag) {
  const listeners = {};
  const classes = new Set();
  return {
    tagName: tag, dataset: {}, style: {}, children: [], value: '', checked: false,
    textContent: '', innerHTML: '', className: '', disabled: false,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); },
      toggle(c, on) { if (on === undefined ? classes.has(c) : !on) classes.delete(c); else classes.add(c); },
    },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    blur() {},
    _listeners: listeners,
    _fire(ev, extra) {
      const e = Object.assign({ target: this, stopPropagation() {}, preventDefault() {} }, extra || {});
      (listeners[ev] || []).forEach((f) => f(e));
    },
  };
}

/** 从 `innerHTML` 里抠出 `data-f="x"` 那个输入框的值 / 勾选状态。 */
function parseField(html, field) {
  const re = new RegExp(`data-f="${field}"[^>]*`, 'i');
  const tag = (html.match(re) || [''])[0];
  const val = (tag.match(/value="([^"]*)"/) || [])[1];
  return {
    value: val == null ? '' : val.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
    checked: /checked/.test(tag),
  };
}

/**
 * 建一个渲染层沙箱。返回 { sandbox, captured, nodeById, setRows, modalBody, modalFoot, isModalOpen }。
 *
 * **core.js 也一起加载**（更真实）——代价是 core 自己定义的 `Modal` 是词法常量，
 * 外部改不了。所以这里不走"替换 Modal"的路子，而是**读真实 Modal 写进 DOM 的内容**：
 * body 看 `$('#modalBody').innerHTML`，按钮看 `$('#modalFoot').children`，
 * 是否打开看 `#modalMask` 的 classList。
 */
function makeSandbox() {
  const captured = { toasts: [], dirty: [] };
  const nodeById = new Map();
  let editorRowHtmls = [];

  const $ = (sel) => {
    if (!nodeById.has(sel)) {
      const e = makeEl('div');
      if (sel === '#modalMask') e.classList.add('hidden');   // 初始与真实 DOM 一致
      // toast 走的是真 core.js 的 `toast()`，它把节点 append 到 `#toasts` ——
      // 想断言提示内容就得在这里收集（而不是替换 toast 函数，那会绕开真实代码路径）。
      if (sel === '#toasts') e.appendChild = (c) => { captured.toasts.push({ msg: c.innerHTML, cls: c.className }); return c; };
      nodeById.set(sel, e);
    }
    return nodeById.get(sel);
  };
  const $$ = (sel) => {
    // 弹窗里的模型行：行数从真实写进 #modalBody 的 HTML 里数 data-i
    if (/tbody tr/.test(sel) && /modalBody/.test(sel)) {
      const html = $('#modalBody').innerHTML || '';
      const n = (html.match(/data-i="/g) || []).length;
      return Array.from({ length: n }, (_, i) => {
        const tr = makeEl('tr');
        tr.dataset.i = String(i);
        const keep = makeEl('input');
        keep.checked = true;
        tr.querySelector = (s) => (s === '[data-keep]' ? keep : makeEl('div'));
        return tr;
      });
    }
    // 编辑抽屉里的模型行：按 setRows() 给的 HTML 造桩，并支持按 data-f 取值
    if (/edModelTable tbody tr/.test(sel)) {
      return editorRowHtmls.map((html) => {
        const tr = makeEl('tr');
        tr.innerHTML = html;
        tr.querySelector = (s) => {
          const m = /data-f="([^"]+)"/.exec(s || '');
          if (!m) return makeEl('div');
          const f = parseField(html, m[1]);
          const inp = makeEl('input');
          inp.value = f.value;
          inp.checked = f.checked;
          return inp;
        };
        return tr;
      });
    }
    return [];
  };

  const sandbox = {
    console,
    document: { querySelector: $, querySelectorAll: $$, createElement: makeEl, body: makeEl('body'), getElementById: () => makeEl('div') },
    window: { getSelection: () => ({ length: 0, toString: () => '' }) },
    setTimeout, clearTimeout, JSON, Math, Number, String, Array, Object, RegExp, Date, isNaN, parseInt, parseFloat, Boolean, Set, Map, Error, Promise,
    $, $$, document_$: $,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ['core.js', 'providers.js']) {
    vm.runInContext(fs.readFileSync(path.join(RJ, f), 'utf8'), sandbox, { filename: f });
  }
  // core.js 里的 `$`/`LG`/`Modal` 是**词法常量**（const），读不到 sandbox 的属性上。
  // 在同一个 context 里再跑一小段，把它们挂出来供测试使用。
  vm.runInContext('globalThis.__refs = { LG, Modal, esc, attr };', sandbox, { filename: 'expose-refs.js' });
  const refs = sandbox.__refs;
  // 只加载了 core.js + providers.js，其它视图的 render 函数不存在。
  // 这里补成空函数 —— 比让被测代码在 `LG.renders.models()` 上抛错要好：
  // 我们要测的是抽屉的生命周期，不是别的视图怎么画。
  refs.LG.renders = Object.assign({
    providers() {}, models() {}, dashboard() {}, clients() {}, settings() {}, logs() {},
  }, refs.LG.renders);
  sandbox.renderTopbar = () => {};
  sandbox.markDirty = () => {};
  return {
    sandbox,
    refs,
    captured,
    nodeById,
    setRows: (a) => { editorRowHtmls = a; },
    modalBody: () => $('#modalBody').innerHTML,
    modalFoot: () => $('#modalFoot').children,
    isModalOpen: () => !$('#modalMask').classList.contains('hidden'),
  };
}

/* ================================================================
 * 一键获取全部模型
 * ================================================================ */

t('渲染层：一键获取模型的选择器**能真正渲染出来**（曾经因 dup 未定义而整个哑掉）', () => {
  const S = makeSandbox();
  const { sandbox } = S;
  assert.strictEqual(typeof sandbox.openModelPicker, 'function', 'providers.js 应导出 openModelPicker');

  const enriched = modelMeta.enrichAll([
    { id: 'deepseek-ai/deepseek-v4.1-flash' },
    { id: 'vendor-a/foo' },
    { id: 'vendor-b/foo' },        // 与上一条撞短名
    { id: 'brand-new-model-2099' }, // 无参数
  ]);
  sandbox.openModelPicker(
    { ok: true, models: enriched.models, unknown: enriched.unknown, count: enriched.models.length },
    { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' },
  );

  assert.ok(S.isModalOpen(), '弹窗必须被打开（旧 bug 下这里会因异常而根本没打开）');
  const body = S.modalBody();
  assert.strictEqual((body.match(/data-i="/g) || []).length, enriched.models.length, '每行都要渲染出来');
  assert.strictEqual((body.match(/data-keep checked/g) || []).length, enriched.models.length, '默认应全选');
  assert.ok(/warn-box/.test(body), '短名冲突要有警告块');
  assert.ok(/本程序不会替你编一个数字/.test(body), '拿不到参数的模型要如实说明，不编数字');
  assert.ok(/deepseek-v4\.1-flash/.test(body), '应显示自动映射后的短名');
});

t('渲染层：一键获取模型的边界数据不抛异常', () => {
  const S = makeSandbox();
  const { sandbox } = S;
  const cases = [
    ['全部无参数且不撞名', modelMeta.enrichAll([{ id: 'a/b' }, { id: 'c/d' }])],
    ['全部能查到参数', modelMeta.enrichAll([{ id: 'deepseek-ai/deepseek-v4.1-flash' }])],
    ['unknown 是 undefined', { models: modelMeta.enrichAll([{ id: 'a/b' }]).models, unknown: undefined }],
    ['上游给了参数', modelMeta.enrichAll([{ id: 'x/y', context_length: 32000, architecture: { input_modalities: ['text', 'image'] } }])],
    ['全是畸形条目', { models: [null, undefined, 0, 'str', []], unknown: [] }],
    ['models 不是数组', { models: 'abc', unknown: null }],
    ['fetched 是 null', null],
  ];
  for (const [label, r] of cases) {
    const S2 = makeSandbox();
    assert.doesNotThrow(() => {
      S2.sandbox.openModelPicker(r, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' });
    }, label + ' 不该抛异常');
  }
});

t('渲染层：空目录不弹空选择器，而是明确提示（畸形上游数据不该给一个空白弹窗）', () => {
  const S = makeSandbox();
  assert.doesNotThrow(() => {
    S.sandbox.openModelPicker({ ok: true, models: [], unknown: [] }, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' });
  });
  assert.strictEqual(S.isModalOpen(), false, '空列表不该打开一个什么都没有的弹窗');
  assert.ok(S.captured.toasts.some((x) => /没有可用的模型条目/.test(x.msg)), '应给出明确提示：' + JSON.stringify(S.captured.toasts));
  // fetched 为 null 也一样：要提示，不能静默
  const S2 = makeSandbox();
  assert.doesNotThrow(() => S2.sandbox.openModelPicker(null, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' }));
  assert.strictEqual(S2.isModalOpen(), false);
  assert.ok(S2.captured.toasts.length >= 1, 'fetched=null 也要有提示，不能静默');
});

t('渲染层：picker 的数字列必须转义（防注入）—— 畸形上游数据不得生成元素', () => {
  const S = makeSandbox();
  const payload = '<img src=x onerror="window.__pwn=1">';
  S.sandbox.openModelPicker({
    ok: true,
    models: [{ id: 'vendor/a', as: 'a', contextWindow: payload, maxTokens: payload, timeoutMs: payload }],
    unknown: [],
  }, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' });
  const body = S.modalBody();
  assert.ok(!/<img/i.test(body), '数字列不得生成元素：' + body.slice(0, 400));
  assert.ok(!/onerror/i.test(body), '不得出现事件属性');
  // 对照：把同一个 payload 放进 id / as，那两处本来就该被 esc 成实体（而不是生成元素）
  const S2 = makeSandbox();
  S2.sandbox.openModelPicker({ ok: true, models: [{ id: payload, as: payload }], unknown: [] }, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' });
  const body2 = S2.modalBody();
  assert.ok(/&lt;img/i.test(body2), 'id/as 应转义成实体');
  assert.ok(!/<img[^&]/i.test(body2.replace(/&lt;img/gi, '')), 'id/as 不得生成真元素');
});

t('渲染层：短名冲突警告用的是 dups（不是每行的 dup）—— 旧 bug 会让整个弹窗打不开', () => {
  const S = makeSandbox();
  const r = modelMeta.enrichAll([{ id: 'vendor-a/foo' }, { id: 'vendor-b/foo' }]);
  S.sandbox.openModelPicker({ ok: true, models: r.models, unknown: r.unknown }, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' });
  assert.ok(S.isModalOpen(), '弹窗必须被打开');
  assert.ok(/有 1 个短名/.test(S.modalBody()), '应显示 1 个重复短名的警告');
});

t('渲染层：选择器的三个快捷按钮与"实测超时"开关都能接上线', () => {
  const S = makeSandbox();
  const { sandbox } = S;
  const r = modelMeta.enrichAll([{ id: 'a/b' }, { id: 'c/d' }]);
  sandbox.openModelPicker({ ok: true, models: r.models, unknown: r.unknown, count: 2 }, { id: 'p', baseURL: 'https://x/v1', apiKey: 'k' });
  // onOpen 已在 Modal.open 里执行；只要它没抛异常，这些监听就都挂上了。
  // 这里再确认 body 里确实有这三个按钮与两个开关（否则选择器会去 addEventListener(null) 而抛错）
  const body2 = S.modalBody();
  for (const needle of ['data-sel="all"', 'data-sel="none"', 'data-sel="known"', 'id="mpMeasure"', 'id="mpReplace"']) {
    assert.ok(body2.includes(needle), '弹窗里应有 ' + needle);
  }
});

/* ================================================================
 * 编辑抽屉的模型表往返（数据丢失那一类 bug）
 * ================================================================ */

t('渲染层：编辑抽屉的模型行往返**不丢字段**（contextWindow / maxTokens / timeoutMs / vision）', () => {
  const { sandbox, setRows } = makeSandbox();
  // 造出"抽屉里已经有这几行"的状态：innerHTML 就是 modelRow 会生成的那种
  const rows = [
    { up: 'm1', as: '', vision: false, contextWindow: 200000, maxTokens: 8000, timeoutMs: 25000 },
    { up: 'm2', as: 'm2-alias', vision: true, contextWindow: 128000, maxTokens: 4096, timeoutMs: 0 },
  ];
  setRows(rows.map((e) => {
    const v = (x) => (x ? String(x) : '');
    return `<td><input data-f="up" value="${v(e.up)}" /></td>`
      + `<td><input data-f="as" value="${v(e.as)}" /></td>`
      + `<td><input type="checkbox" data-f="vision" ${e.vision ? 'checked' : ''} /></td>`
      + `<td><input data-f="contextWindow" value="${v(e.contextWindow)}" /></td>`
      + `<td><input data-f="maxTokens" value="${v(e.maxTokens)}" /></td>`
      + `<td><input data-f="timeoutMs" value="${v(e.timeoutMs)}" /></td>`;
  }));

  const out = sandbox.readEditorModels();
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'm1');
  assert.strictEqual(out[0].contextWindow, 200000, 'contextWindow 不能丢');
  assert.strictEqual(out[0].maxTokens, 8000, 'maxTokens 不能丢');
  assert.strictEqual(out[0].timeoutMs, 25000, 'timeoutMs 不能丢（新字段最容易漏）');
  assert.strictEqual(out[1].as, 'm2-alias');
  assert.strictEqual(out[1].vision, true);
  assert.strictEqual(out[1].timeoutMs, undefined, '留空不应写成一个 0/NaN');
});

t('渲染层：modelEntriesOf 必须带出 timeoutMs（否则打开编辑再应用就把它抹掉了）', () => {
  const { sandbox } = makeSandbox();
  const e = sandbox.modelEntriesOf({
    models: [{ id: 'a/b', as: 'b', contextWindow: 1000, maxTokens: 500, timeoutMs: 20000, vision: true }, 'plain'],
  });
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].timeoutMs, 20000);
  assert.strictEqual(e[0].contextWindow, 1000);
  assert.strictEqual(e[0].maxTokens, 500);
  assert.strictEqual(e[0].vision, true);
  assert.strictEqual(e[1].up, 'plain', '字符串形态的条目也要支持');
});

/* ================================================================
 * 编辑抽屉的生命周期（监听器堆积 / 取消回滚）
 * ================================================================ */

t('渲染层：反复打开编辑抽屉**不会累积监听器**（旧 bug：点一次「应用」执行 N 次）', () => {
  const S = makeSandbox();
  S.refs.LG.config = { providers: [{ id: 'p0', baseURL: 'https://a/v1', models: [] }] };

  // initProviders 只跑一次（等价于 boot 时的 LG.initProviders()）
  S.refs.LG.initProviders();
  const btnApply = S.nodeById.get('#btnEditorApply');
  assert.strictEqual((btnApply._listeners.click || []).length, 1, 'initProviders 后应恰好 1 个监听器');

  // 像用户那样反复打开/关闭抽屉
  for (let i = 0; i < 5; i++) {
    S.sandbox.openEditor(0);
    S.sandbox.closeEditor();
  }
  assert.strictEqual((btnApply._listeners.click || []).length, 1,
    '打开 5 次后仍应只有 1 个监听器，实际 ' + (btnApply._listeners.click || []).length
    + '（旧实现在 wireEditor 里挂，每开一次叠一层 → 点一次「应用」会执行 N 遍，'
    + '第 2..N 遍撞唯一性校验，弹出 N-1 条红色"ID 已存在"）');
  for (const id of ['#btnEditorCancel', '#btnEditorClose', '#btnEditorDelete', '#editorMask']) {
    assert.strictEqual((S.nodeById.get(id)._listeners.click || []).length, 1, id + ' 也应当只有 1 个监听器');
  }
});

t('渲染层：「添加供应商 → 取消」必须回滚，不能在配置里留空条目', () => {
  const S = makeSandbox();
  S.refs.LG.config = { providers: [{ id: 'x1', baseURL: 'https://a/v1', models: [] }] };

  S.sandbox.addProvider();
  assert.strictEqual(S.refs.LG.config.providers.length, 2, '添加后应多一条（抽屉里编辑它）');
  S.sandbox.closeEditor();
  assert.strictEqual(S.refs.LG.config.providers.length, 1,
    '点「取消」应把它回滚掉 —— 否则连点 3 次就留下 3 个没有 baseURL 的空供应商，'
    + '之后「保存并生效」会被校验拦下，用户还不知道为什么');

  for (let i = 0; i < 3; i++) { S.sandbox.addProvider(); S.sandbox.closeEditor(); }
  assert.strictEqual(S.refs.LG.config.providers.length, 1, '连点 3 次也不该留下任何残留');
  assert.deepStrictEqual(S.refs.LG.config.providers.map((p) => p.id), ['x1']);
});

t('渲染层：testAll 在 IPC 返回 null / {ok:false} 时不得谎报成功，且要清掉 busy', () => {
  // 旧实现：`(r.results || [])` 有几行漏了 `r &&` → r=null 时 TypeError，
  // 且 LG.testResults 里的 busy 永不清除 → 卡片上的测试圆点**永久转圈**；
  // r={ok:false} 时会谎报"0 家正常 / 0 家异常 / 其余未知"，用户以为测过了。
  const cases = [['null', null], ['ok:false', { ok: false, error: '内部错误' }], ['空 results', { ok: true, results: [] }]];
  const checks = cases.map(([label, ret]) => {
    const S = makeSandbox();
    S.refs.LG.config = { providers: [{ id: 'p1', baseURL: 'https://a/v1', models: [] }] };
    S.refs.LG.testResults = {};
    S.sandbox.window.lgw = { gwTestProviders: () => Promise.resolve(ret) };
    return S.sandbox.testAll().then(() => {
      const busy = Object.values(S.refs.LG.testResults).filter((x) => x && x.busy).length;
      assert.strictEqual(busy, 0, label + '：busy 必须被清掉，否则圆点永久转圈');
      const said = S.captured.toasts.map((t) => t.msg).join('｜');
      assert.ok(!/0 家正常 \/ 0 家异常/.test(said),
        label + '：不得把一次彻底失败报成"0 家正常 / 0 家异常"（用户会以为测过了）。实际：' + said);
    });
  });
  return Promise.all(checks);
});

/* ================================================================
 * 双击供应商卡片
 * ================================================================ */

t('渲染层：双击供应商卡片打开编辑抽屉；双击卡片内的按钮不打开', () => {
  const S = makeSandbox();
  const { sandbox, nodeById } = S;
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = makeEl('div');
    row.dataset.idx = String(i);
    row.querySelectorAll = () => [];
    rows.push(row);
  }
  const listEl = makeEl('div');
  listEl.querySelectorAll = (sel) => {
    if (sel === '.prov') return rows;
    return [];
  };
  nodeById.set('#provList', listEl);

  // core.js 里 LG.config 初始是 null（要等 setConfigFromText 才赋值），这里直接给一份
  S.refs.LG.config = {
    providers: [
      { id: 'p0', baseURL: 'https://a/v1', models: [] },
      { id: 'p1', baseURL: 'https://b/v1', models: [] },
      { id: 'p2', baseURL: 'https://c/v1', models: [] },
    ],
  };
  let opened = null;
  sandbox.openEditor = (i) => { opened = i; };

  assert.doesNotThrow(() => sandbox.wireProviderRows(), 'wireProviderRows 不该抛异常');
  rows.forEach((r, i) => {
    assert.strictEqual((r._listeners.dblclick || []).length, 1, `第 ${i} 张卡片应挂上 dblclick`);
  });

  rows[2]._fire('dblclick');
  assert.strictEqual(opened, 2, '双击第 3 张卡片应打开第 3 个供应商');

  // 双击卡片里的按钮/开关不该弹抽屉（否则"启用/禁用"点两下就弹出编辑器）
  opened = null;
  const inner = makeEl('button');
  inner.closest = (s) => (/button/.test(s) ? inner : null);
  rows[0]._listeners.dblclick[0]({ target: inner, stopPropagation() {}, preventDefault() {} });
  assert.strictEqual(opened, null, '双击卡片内的按钮不该打开抽屉');

  // 正在选文字时也不该打开
  const selWin = { length: 5, toString: () => '选中的文字' };
  sandbox.window.getSelection = () => selWin;
  rows[1]._listeners.dblclick[0]({ target: makeEl('div'), stopPropagation() {}, preventDefault() {} });
  assert.strictEqual(opened, null, '正在选中文字时不该打开抽屉');
});

run();
