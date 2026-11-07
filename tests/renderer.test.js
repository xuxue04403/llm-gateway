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

/**
 * 从 `innerHTML` 里抠出 `data-f="x"` 那个控件的值 / 勾选状态。
 *
 * ⚠ `<select>` 的值不在标签的 `value=` 属性上，而在**被选中的那个 `<option>`** 里。
 * 旧实现只认 `value="…"`，于是对下拉框一律返回 ''：`data-f="api"`（逐模型协议）
 * 明明渲染出来了、也明明有值，往返测试却读到空 —— 这种"桩比被测代码更弱"的假阴性
 * 正是 `api` 被静默抹掉却一直没被测出来的原因之一。
 */
function parseField(html, field) {
  const re = new RegExp(`data-f="${field}"[^>]*`, 'i');
  const tag = (html.match(re) || [''])[0];
  const unesc = (s) => String(s == null ? '' : s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  // ⚠ 判据必须看 `html`，不能看 `tag`：`tag` 是从 `data-f="api"` **开始**匹配的，
  // 里面根本不含 `<select` 本身（写成 /^<select/.test(tag) 永远为假，会静默退回下面的
  // input 分支，于是下拉框一律读成空字符串）。
  if (new RegExp(`<select[^>]*data-f="${field}"`, 'i').test(html)) {
    // 取该 select 到 </select> 之间的内容，找带 selected 的 option
    const seg = (html.match(new RegExp(`data-f="${field}"[\\s\\S]*?</select>`, 'i')) || [''])[0];
    const opt = (seg.match(/<option[^>]*\bselected\b[^>]*>/i) || [])[0] || '';
    const v = (opt.match(/value="([^"]*)"/) || [])[1];
    return { value: unesc(v), checked: false };
  }
  const val = (tag.match(/value="([^"]*)"/) || [])[1];
  return { value: unesc(val), checked: /checked/.test(tag) };
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
  for (const f of ['core.js', 'providers.js', 'dashboard.js']) {
    vm.runInContext(fs.readFileSync(path.join(RJ, f), 'utf8'), sandbox, { filename: f });
  }
  // core.js 里的 `$`/`LG`/`Modal` 是**词法常量**（const），读不到 sandbox 的属性上。
  // 在同一个 context 里再跑一小段，把它们挂出来供测试使用。
  vm.runInContext('globalThis.__refs = { LG, Modal, esc, attr, renderTopbar };', sandbox, { filename: 'expose-refs.js' });
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

t('渲染层：编辑抽屉的模型行往返**不丢字段**（contextWindow / maxTokens / timeoutMs / vision / **api**）', () => {
  const { sandbox, setRows } = makeSandbox();
  // 造出"抽屉里已经有这几行"的状态：innerHTML 就是 modelRow 会生成的那种
  const rows = [
    { up: 'm1', as: '', vision: false, contextWindow: 200000, maxTokens: 8000, timeoutMs: 25000, api: 'openai-responses' },
    { up: 'm2', as: 'm2-alias', vision: true, contextWindow: 128000, maxTokens: 4096, timeoutMs: 0, api: '' },
  ];
  const sel = (v) => ['', 'openai-chat', 'anthropic-messages', 'openai-responses']
    .map((x) => `<option value="${x}"${x === v ? ' selected' : ''}>${x || '跟随'}</option>`).join('');
  setRows(rows.map((e) => {
    const v = (x) => (x ? String(x) : '');
    return `<td><input data-f="up" value="${v(e.up)}" /></td>`
      + `<td><input data-f="as" value="${v(e.as)}" /></td>`
      + `<td><select data-f="api">${sel(e.api)}</select></td>`
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
  // 逐模型协议：漏了它 = 每次「应用」都把协议抹掉，按模型区分协议的上游会整体 400
  assert.strictEqual(out[0].api, 'openai-responses', 'api（逐模型协议）不能丢');
  assert.strictEqual(out[1].as, 'm2-alias');
  assert.strictEqual(out[1].vision, true);
  assert.strictEqual(out[1].timeoutMs, undefined, '留空不应写成一个 0/NaN');
  assert.strictEqual(out[1].api, undefined, '「跟随」不应写成一个空字符串');
});

t('渲染层：modelRow **真的渲染出协议下拉框**（手工拼 HTML 的测试测不到这一处）', () => {
  // 上面那个往返测试的 HTML 是测试自己拼的 —— 就算 modelRow 完全不生成协议列，
  // 它也照样通过。这一条专门守**渲染侧**：modelRow 必须产出 data-f="api"。
  const { sandbox } = makeSandbox();
  assert.strictEqual(typeof sandbox.modelRow, 'function', 'modelRow 应当可用（函数声明会挂到沙箱全局）');
  const api = sandbox.modelRow({ up: 'x', as: '', api: 'anthropic-messages' }).innerHTML;
  assert.ok(/data-f="api"/.test(api), 'modelRow 必须生成 data-f="api" 控件');
  assert.ok(/<option value="anthropic-messages" selected/.test(api), '当前值必须被选中');
  const none = sandbox.modelRow({ up: 'y', as: '' }).innerHTML;
  assert.ok(/<option value="" selected/.test(none), '未声明时默认选中「跟随」');
});

t('渲染层：modelEntriesOf 必须带出 timeoutMs 与 api（否则打开编辑再应用就把它抹掉了）', () => {
  const { sandbox } = makeSandbox();
  const e = sandbox.modelEntriesOf({
    models: [
      { id: 'a/b', as: 'b', contextWindow: 1000, maxTokens: 500, timeoutMs: 20000, vision: true, api: 'openai-responses' },
      'plain',
    ],
  });
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].timeoutMs, 20000);
  assert.strictEqual(e[0].contextWindow, 1000);
  assert.strictEqual(e[0].maxTokens, 500);
  assert.strictEqual(e[0].vision, true);
  assert.strictEqual(e[0].api, 'openai-responses', 'api 必须原样带出，否则往返即抹掉');
  assert.strictEqual(e[1].up, 'plain', '字符串形态的条目也要支持');
  assert.strictEqual(e[1].api, undefined, '没声明就不该凭空造一个');
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

t('渲染层：代理降级必须在列表上方说出来（否则「连不上」会被当成渠道坏了）', () => {
  // 2026-11-03 现场：代理没开时 4 家齐刷刷"连不上（直连）"，而它们的真实调用几乎全成功。
  // 主进程 resolveProxy 早就静默降级了，但界面从不显示 —— 用户只会去改配置/换 Key。
  const S = makeSandbox();
  S.refs.LG.config = { providers: [{ id: 'p1', baseURL: 'https://a/v1', models: [] }] };
  S.refs.LG.testResults = {};
  S.sandbox.window.lgw = {
    gwTestProviders: () => Promise.resolve({
      ok: true,
      proxyNote: { warn: true, configured: 'http://127.0.0.1:7890', used: '', mode: 'fallback' },
      results: [{ id: 'p1', ok: null, verdict: '连不上（直连）：AggregateError' }],
    }),
  };
  return S.sandbox.testAll().then(() => {
    const box = S.nodeById.get('#provList');
    assert.ok(/本次测试时本机代理/.test(String(box.innerHTML)),
      '降级事实必须写在列表上方。实际：' + String(box.innerHTML).slice(0, 200));
    const said = S.captured.toasts.map((t) => t.msg).join('｜');
    assert.ok(/1 家判不出来/.test(said), '判不出来要单独报，不能混进异常。实际：' + said);
    assert.ok(!/1 家异常/.test(said), 'ok:null 不得算成"异常"。实际：' + said);
  });
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

/* ================================================================
 * 概览页：配置里写的代理连不上时**必须显示出来**
 *
 * 背景（用户实测）：把带 `"proxy": {"enabled": true, "url": "http://127.0.0.1:7890"}` 的配置
 * 拷到没装代理的机器上 → 每个未标直连的供应商请求都失败，而概览页显示"运行中"、一切正常。
 * 主进程已改成"探测不过就降级"（gateway-manager.resolveProxy），这条用例钉住**界面也要说**。
 * ================================================================ */

t('渲染层：配置的代理连不上时概览页必须写明（否则用户只看到"所有模型都调不通"）', () => {
  const S = makeSandbox();
  const { refs, sandbox } = S;
  refs.LG.state = { gateway: { running: true, ready: true, port: 3091, configPath: 'C:\\x\\gateway.config.json' } };
  refs.LG.config = { providers: [], apiKey: 'k' };
  const el = () => sandbox.document.querySelector('#dashProxy');

  // ① 正常注入代理：显示代理地址，且**不得无端告警**
  refs.LG.health = { accounts: [], proxy: { url: 'http://127.0.0.1:7890', noProxy: 'a,b,c' }, proxyNote: { reason: 'config', warn: false } };
  refs.LG.renders.dashboard();
  assert.ok(/代理 http:\/\/127\.0\.0\.1:7890/.test(el().textContent), '应显示代理地址：' + el().textContent);
  assert.ok(/3 个域名直连/.test(el().textContent), '应带上直连域名数：' + el().textContent);
  assert.ok(!/连不上/.test(el().innerHTML), '一切正常时不该出现告警：' + el().innerHTML);

  // ② 降级为直连：必须写明"配置的代理连不上"，并说明已直连
  refs.LG.health = {
    accounts: [], proxy: { url: '' },
    proxyNote: { reason: 'config-unreachable', warn: true, configured: 'http://127.0.0.1:7890', used: '' },
  };
  refs.LG.renders.dashboard();
  const html = el().innerHTML;
  assert.ok(/连不上/.test(html), '必须写明代理连不上：' + html);
  assert.ok(/7890/.test(html), '必须指出是哪个地址连不上：' + html);
  assert.ok(/已直连/.test(html), '必须写明已降级为直连：' + html);
  assert.ok(/tag warn/.test(html), '这类事实应当用告警样式，而不是和正常状态长得一样：' + html);

  // ③ 降级到了另一个可用代理：文案要说明"改用了谁"，不能说成直连
  refs.LG.health.proxyNote = {
    reason: 'config-unreachable', warn: true, configured: 'http://127.0.0.1:7890', used: 'http://127.0.0.1:7897',
  };
  refs.LG.renders.dashboard();
  assert.ok(/改用 http:\/\/127\.0\.0\.1:7897/.test(el().innerHTML),
    '有替代代理时必须写明改用了谁（写成"直连"就是谎报）：' + el().innerHTML);
});

t('渲染层：预置配置的首启引导必须出现，配好后必须消失（v1.0.0 预置 9 家模板）', () => {
  // 背景：v1.0.0 起 example 里预置 9 家供应商（全部 enabled:false、apiKey 统一占位值），
  // 而顶层 Key 仍是 `dsh-gateway-change-me` 时 validateConfigText **拒绝保存**。
  // 旧界面没有任何提示 —— 新用户点保存只看到失败、不知道要先生成 Key。
  const S = makeSandbox();
  const { refs, sandbox } = S;
  refs.LG.state = { gateway: { running: true, ready: true, port: 3091, configPath: 'C:\\x\\gateway.config.json' } };
  const card = () => sandbox.document.querySelector('#firstRunCard');
  const bodyOf = () => sandbox.document.querySelector('#firstRunBody').innerHTML;

  // ① 全新安装：占位顶层 Key + 9 家全停用 + 占位供应商 Key → 三条待办都要出现
  refs.LG.config = {
    apiKey: 'dsh-gateway-change-me',
    providers: [
      { id: 'sensenova', enabled: false, apiKey: 'sk-llm-gatway-xxxxxxxx' },
      { id: 'amd', enabled: false, apiKey: 'sk-llm-gatway-xxxxxxxx' },
    ],
  };
  refs.LG.health = { accounts: [], proxy: { url: '' } };
  refs.LG.renders.dashboard();
  assert.notStrictEqual(card().style.display, 'none', '首启时引导卡必须显示');
  const b1 = bodyOf();
  assert.ok(/生成本机统一 Key/.test(b1), '要提示生成统一 Key：' + b1);
  assert.ok(/启用至少一家供应商/.test(b1), '要提示启用供应商：' + b1);
  assert.ok(/填入你自己的供应商 Key/.test(b1), '要提示填自己的供应商 Key：' + b1);
  assert.ok(/sk-llm-gatway-xxxxxxxx/.test(b1), '要点出占位 Key 的值，用户才知道该换掉什么：' + b1);
  assert.strictEqual((b1.match(/tag warn/g) || []).length, 3, '三条都应是"待办"：' + b1);

  // ② 只生成了 Key、还没启用供应商 → 剩两条待办
  refs.LG.config.apiKey = 'lgw-' + 'a'.repeat(48);
  refs.LG.renders.dashboard();
  const b2 = bodyOf();
  assert.ok(/tag ok/.test(b2), '已完成的步骤要标出来：' + b2);
  assert.strictEqual((b2.match(/tag warn/g) || []).length, 2, '应剩两条待办：' + b2);

  // ③ 全部配好 → 整块隐藏（老用户升级上来不该看到多余引导）
  refs.LG.config.providers = [{ id: 'sensenova', enabled: true, apiKey: 'sk-mine-1234567890' }];
  refs.LG.renders.dashboard();
  assert.strictEqual(card().style.display, 'none', '配好后引导卡必须隐藏；残留会长期占屏');

  // ④ workbuddy 例外：走桌面端凭据（auth: workbuddy + accounts），不该被要求填 apiKey
  refs.LG.config.providers = [{ id: 'workbuddy', enabled: true, auth: 'workbuddy', accounts: [{ id: 'acct1' }] }];
  refs.LG.renders.dashboard();
  assert.strictEqual(card().style.display, 'none',
    'workbuddy 靠 accounts 凭据可用，不该被误判成"没填 Key"而一直显示引导');
});

run();

/* ================================================================
 * 概览页：防护计数必须说人话（审计 R11）
 *
 * 背景：magpie 三项防护（循环守卫 / 工具死循环拦截 / 上下文窗口过滤）默认全开，
 * 但界面上此前一个字都没有。用户既无法确认它们在干活，也无法在它们误伤时发现 ——
 * R10 那个 pendingHead 缺陷就是"代码写了、永远不触发、没人察觉"的实例。
 *
 * 这条用例重点钉住两种"0"不能长得一样：
 *   - 用户自己关掉了 → 必须显示「已关闭」；
 *   - 开着但没触发过 → 必须显示「已开启 · 暂未触发」。
 * 混在一起会让"关了"看起来像"工作了但没事发生"，那正是要避免的那类谎。
 * ================================================================ */

t('渲染层：防护计数必须区分「已关闭」与「已开启但未触发」—— 两种 0 不能长一样', () => {
  const S = makeSandbox();
  const { refs, sandbox } = S;
  refs.LG.state = { gateway: { running: true, ready: true, port: 3091, configPath: 'C:\\x\\gateway.config.json' } };
  refs.LG.config = { providers: [], apiKey: 'k' };
  const box = () => sandbox.document.querySelector('#guardsBox');

  // ① 三个都开着、都没触发过：必须说"暂未触发"，不能说成"已生效 0 次"那种含糊话，
  //    更不能画一排 0 让人以为坏了。
  refs.LG.health = {
    accounts: [],
    guards: { loopGuard: 0, toolLoop: 0, roomy: 0, enabled: { loopGuard: true, toolLoop: true, roomy: true, roomyLearn: false } },
  };
  refs.LG.renders.dashboard();
  let html = box().innerHTML;
  assert.ok(/循环守卫/.test(html), '必须列出循环守卫：' + html);
  assert.ok(/工具死循环拦截/.test(html), '必须列出工具死循环拦截：' + html);
  assert.ok(/上下文窗口过滤/.test(html), '必须列出上下文窗口过滤：' + html);
  assert.strictEqual((html.match(/暂未触发/g) || []).length, 3, '三个都该显示「暂未触发」：' + html);
  assert.ok(!/已关闭/.test(html), '全开着时不该出现「已关闭」：' + html);

  // ② 触发过：显示实际次数（这才是用户真正想看的东西 —— "它替我拦了几次"）
  refs.LG.health.guards = { loopGuard: 3, toolLoop: 1, roomy: 12, enabled: { loopGuard: true, toolLoop: true, roomy: true, roomyLearn: false } };
  refs.LG.renders.dashboard();
  html = box().innerHTML;
  assert.ok(/已生效 3 次/.test(html), '循环守卫该显示 3 次：' + html);
  assert.ok(/已生效 1 次/.test(html), '工具死循环该显示 1 次：' + html);
  assert.ok(/已生效 12 次/.test(html), '窗口过滤该显示 12 次：' + html);
  assert.ok(!/暂未触发/.test(html), '有触发时不该残留「暂未触发」：' + html);

  // ③ 用户关掉了循环守卫：必须明确说「已关闭」，且不能显示成"已开启·暂未触发"。
  //    这是本条用例的核心：关掉和没触发是**完全不同**的事实，界面必须能分辨。
  refs.LG.health.guards = { loopGuard: 0, toolLoop: 0, roomy: 0, enabled: { loopGuard: false, toolLoop: true, roomy: true, roomyLearn: false } };
  refs.LG.renders.dashboard();
  html = box().innerHTML;
  assert.ok(/已关闭/.test(html), '关掉的那项必须显示「已关闭」：' + html);
  assert.strictEqual((html.match(/暂未触发/g) || []).length, 2, '只有真开着的两项才该显示「暂未触发」：' + html);

  // ④ 老引擎（v1.0.19 之前）没有 guards 字段：如实说不支持，而不是画一排 0 假装在工作。
  refs.LG.health = { accounts: [] };
  refs.LG.renders.dashboard();
  html = box().innerHTML;
  assert.ok(/不支持防护计数/.test(html), '老引擎必须如实说不支持：' + html);
  assert.ok(!/暂未触发/.test(html), '不支持时不得画假的「暂未触发」：' + html);

  // ⑤ 网关未运行：说未运行，不编数据
  refs.LG.state.gateway.running = false;
  refs.LG.renders.dashboard();
  assert.ok(/网关未运行/.test(box().innerHTML), '未运行时要说明：' + box().innerHTML);
});

/* ================================================================
 * 供应商排序：直接输入序号跳转
 *
 * 背景（用户实测反馈）：▲▼ 一次只挪一位，把第 20 家拖到第 2 位要点 18 次；
 * 拖拽能一步到位，但目标行常在屏幕外、还得找准缝隙。用户明确要求"直接改序号"。
 *
 * 语义必须与拖拽一致：只重排 `LG.config.providers` 数组，**不碰 priority**
 * （表头写着"跨优先级调序请改 priority 数字"）。用插入语义（moveItem）而不是
 * 交换（swap）：移到第 4 位时中间那些行要整体让位，swap 只会交换两行。
 * ================================================================ */

/** 造一个能被 wireProviderRows 认出来的 `#provList`，并把 `input[data-jump]` 换成真实可点桩。 */
function provListWithJumpInputs(S, n) {
  const listEl = makeEl('div');
  const jumps = [];
  for (let i = 0; i < n; i++) {
    const inp = makeEl('input');
    inp.dataset.jump = String(i);
    inp.value = String(i + 1);
    // ⚠ makeEl 默认 `closest()` 恒返回 null，而实现靠 `e.target.closest('input,…')`
    //    判断"按下的是不是表单控件"。不补这一处，测试里输入框永远"不是控件"，
    //    拦截分支就永远进不去 —— 会把一个能用的实现判成坏的（假阴性）。
    inp.closest = (sel) => (/input/.test(sel) ? inp : null);
    jumps.push(inp);
  }
  // wireProviderRows 会依次问：`[data-act]` / `input[data-jump]` / `input[data-act="toggle"]` / `.prov`
  listEl.querySelectorAll = (sel) => (sel === 'input[data-jump]' ? jumps : []);
  S.nodeById.set('#provList', listEl);
  return jumps;
}

t('渲染层：供应商序号必须是可输入的框（不再是纯文本 #N）—— 长列表才能一步跳到目标位次', () => {
  const S = makeSandbox();
  const { refs } = S;
  refs.LG.config = {
    providers: [
      { id: 'p0', baseURL: 'https://a/v1', models: [] },
      { id: 'p1', baseURL: 'https://b/v1', models: [] },
      { id: 'p2', baseURL: 'https://c/v1', models: [] },
    ],
  };
  refs.LG.renders.providers();
  const html = S.nodeById.get('#provList').innerHTML;

  assert.ok(/<input class="idx-in" type="number"/.test(html), '序号应渲染成数字输入框：' + html);
  // 纯文本 `#1</span>` 那种形态必须消失，否则用户看到的还是不能改的死数字
  assert.ok(!/<span class="idx">#\d/.test(html), '不得残留纯文本序号：' + html);

  // 三个框各自记住自己的位次：data-jump 是**数组下标**（0 基），value 是给用户看的 1 基
  const jump = [...html.matchAll(/data-jump="(\d+)"/g)].map((m) => m[1]);
  // ⚠ 顺序是 `value="N"` 在前、`data-jump="i"` 在后（见 providers.js 的模板），
  //   反过来写会一个都抓不到 —— 那种"正则写错了却说断言过了"的假阴性要靠 deepStrictEqual 兜住。
  const vals = [...html.matchAll(/value="(\d+)" data-jump="(\d+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(jump, ['0', '1', '2'], 'data-jump 必须是从 0 开始的数组下标：' + html);
  assert.deepStrictEqual(vals, ['1', '2', '3'], '显示值必须是 1 基位次：' + html);

  // 越界输入要被浏览器拦住，不能靠 JS 兜底（用户按 ↑ 键到顶时就该停）
  assert.ok(/data-jump="0"[^>]*min="1"/.test(html) || /min="1"[^>]*data-jump="0"/.test(html), '应有 min=1：' + html);
  assert.ok(/max="3"/.test(html), 'max 应等于供应商总数：' + html);
});

t('渲染层：输入位次是"跳到第 N 位"（插入语义，不是交换），且越界不动、Escape 还原', () => {
  const S = makeSandbox();
  const { refs, captured } = S;
  const ids = () => refs.LG.config.providers.map((p) => p.id);
  refs.LG.config = {
    providers: [
      { id: 'p0', baseURL: 'https://a/v1', models: [], priority: 1 },
      { id: 'p1', baseURL: 'https://b/v1', models: [], priority: 2 },
      { id: 'p2', baseURL: 'https://c/v1', models: [], priority: 3 },
      { id: 'p3', baseURL: 'https://d/v1', models: [], priority: 4 },
      { id: 'p4', baseURL: 'https://e/v1', models: [], priority: 5 },
    ],
  };
  const jumps = provListWithJumpInputs(S, 5);
  const prioritiesBefore = refs.LG.config.providers.map((p) => p.priority);

  assert.doesNotThrow(() => S.sandbox.wireProviderRows());
  jumps.forEach((inp, i) => {
    assert.strictEqual((inp._listeners.keydown || []).length, 1, `第 ${i} 个序号框应挂上 keydown`);
    assert.strictEqual((inp._listeners.change || []).length, 1, `第 ${i} 个序号框应挂上 change`);
  });

  // ① 核心用例：把第 1 位（p0）移到第 4 位。
  //    moveItem(0,3) → [p1,p2,p3,p0,p4]。若是 swap，会变成 [p3,p1,p2,p0,p4] ——
  //    那样"第 2、3 位是谁"全变了，用户看到的不是"其它行整体上移一格"。
  jumps[0].value = '4';
  jumps[0]._fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(ids(), ['p1', 'p2', 'p3', 'p0', 'p4'],
    '「移到第 4 位」必须整体让位而不是交换两行：' + ids().join(','));
  // ⚠ 断言的是"没有任何 priority 被**改写**"，不是"数组里的 priority 序列不变" ——
  //   p0 自己带着 priority=1 一起搬到了第 4 位，序列当然会变。要钉的是
  //   "重排数组不会去动 priority 这个字段"（表头那句"跨优先级调序请改 priority 数字"）。
  assert.deepStrictEqual(refs.LG.config.providers.map((p) => p.priority).sort(), prioritiesBefore,
    '重排数组不得改动 priority 字段的值（只是搬迁）：' + refs.LG.config.providers.map((p) => p.priority).join(','));
  assert.strictEqual(refs.LG.config.providers[3].priority, 1, 'p0 必须带着自己的 priority=1 一起搬');
  assert.ok(captured.toasts.some((x) => /已移到第 4 位/.test(x.msg)), '应有「已移到第 4 位」提示：' + JSON.stringify(captured.toasts));

  // ② 原地不动：输同一个位次不该报错、也不该提示
  const nToast = captured.toasts.length;
  jumps[1].value = '2';   // 下标 1 现在是 p2，本来就是第 2 位
  jumps[1]._fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(ids(), ['p1', 'p2', 'p3', 'p0', 'p4'], '输入当前位次不该改变顺序');
  assert.strictEqual(captured.toasts.length, nToast, '原地不动不该弹提示');

  // ③ 越界：不能"就近 clamp"（悄悄挪到最后一格比什么都不做更让人困惑）
  jumps[0].value = '99';
  jumps[0]._fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(ids(), ['p1', 'p2', 'p3', 'p0', 'p4'], '越界输入必须什么都不做');
  assert.strictEqual(jumps[0].value, '1', '越界后显示值必须弹回真实位次：' + jumps[0].value);
  assert.ok(captured.toasts.some((x) => /位次要在 1 – 5 之间/.test(x.msg)), '越界应给出可读提示：' + JSON.stringify(captured.toasts));

  // ④ 空输入 / 小数同样不动（type=number 里 `abc` 会变成空串，那是最常见的误触）
  jumps[2].value = '';
  jumps[2]._fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(ids(), ['p1', 'p2', 'p3', 'p0', 'p4'], '空输入不得移动');
  jumps[2].value = '2.5';
  jumps[2]._fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(ids(), ['p1', 'p2', 'p3', 'p0', 'p4'], '非整数不得移动');

  // ⑤ Escape：放弃这次输入，值回到当前真实位次，顺序不变
  jumps[3].value = '1';
  jumps[3]._fire('keydown', { key: 'Escape' });
  assert.deepStrictEqual(ids(), ['p1', 'p2', 'p3', 'p0', 'p4'], 'Escape 不得移动');
  assert.strictEqual(jumps[3].value, '4', 'Escape 后应还原成当前位次：' + jumps[3].value);

  // ⑥ 失焦提交（change）：输了数字直接点别处也不该白输 —— 与回车等价
  const jumps2 = provListWithJumpInputs(S, 5);
  S.sandbox.wireProviderRows();
  jumps2[4].value = '1';   // 把最后一位（p4）提到最前
  jumps2[4]._fire('change');
  assert.deepStrictEqual(ids(), ['p4', 'p1', 'p2', 'p3', 'p0'],
    'change（失焦）也必须提交：' + ids().join(','));
});

t('渲染层：在序号框里拖选数字不得拖走整行（draggable 祖先会抢走 dragstart）', () => {
  const S = makeSandbox();
  const { refs } = S;
  refs.LG.config = {
    providers: [
      { id: 'p0', baseURL: 'https://a/v1', models: [] },
      { id: 'p1', baseURL: 'https://b/v1', models: [] },
    ],
  };
  const jumps = provListWithJumpInputs(S, 2);

  // 造两张真实的"行"桩：行上挂着 mousedown / dragstart，内部有一个序号框
  const rows = jumps.map((inp) => {
    const row = makeEl('div');
    row.dataset.idx = String(Number(inp.dataset.jump));
    const handle = makeEl('span');
    handle.innerHTML = '';           // .handle 不是表单控件
    row.querySelectorAll = () => [];
    row._jumpInput = inp;
    return row;
  });
  const listEl = S.nodeById.get('#provList');
  listEl.querySelectorAll = (sel) => {
    if (sel === 'input[data-jump]') return jumps;
    if (sel === '.prov') return rows;
    return [];
  };
  assert.doesNotThrow(() => S.sandbox.wireProviderRows());

  // ① 鼠标按在序号框里再拖 → 行的 dragstart 必须被 preventDefault，且不得进入拖拽态
  const row0 = rows[0];
  assert.strictEqual((row0._listeners.mousedown || []).length, 1, '行应挂 mousedown 以记住按下目标');
  assert.strictEqual((row0._listeners.dragstart || []).length, 1, '行应挂 dragstart');

  // 关键：`dragstart` 的 target 是**行**（浏览器行为），不是里面的 input。
  // 所以判据不能看 e.target.closest('input')，只能看 mousedown 时记下的标记 ——
  // 这正是第一版实现的 bug（实测 target 是 `<div class="prov dragging">`，
  // closest 恒为 null，拦截形同虚设）。
  row0._fire('mousedown', { target: jumps[0] });
  let prevented = false;
  row0._fire('dragstart', {
    target: row0,
    preventDefault() { prevented = true; },
    dataTransfer: { effectAllowed: '', setData() {} },
  });
  assert.strictEqual(prevented, true, '按在序号框里拖动时，行的 dragstart 必须 preventDefault');
  assert.ok(!row0.classList.contains('dragging'), '被拦下的拖拽不得给行加 .dragging');

  // ② 按在手柄/空白处再拖 → 必须正常进入拖拽态（别把正常拖拽排序弄坏）
  row0._fire('mousedown', { target: makeEl('span') });   // .closest 返回 null 的普通元素
  prevented = false;
  let picked = null;
  row0._fire('dragstart', {
    target: row0,
    preventDefault() { prevented = true; },
    dataTransfer: { effectAllowed: '', setData(k, v) { picked = v; } },
  });
  assert.strictEqual(prevented, false, '从手柄发起拖拽不得被拦');
  assert.ok(row0.classList.contains('dragging'), '正常拖拽必须进入 dragging 态');
  assert.strictEqual(picked, '0', '正常拖拽要把行下标写进 dataTransfer');
});

/* ================================================================
 * 设置页：工具裁剪开关（maxTools）
 *
 * 背景：maxTools 的引擎缺省值是 0（关闭），但**设置页此前根本没有这个开关** ——
 * 只有一个隐含在文档里的数字。用户要开/关只能手改 gateway.config.json，
 * 而那份文件会被界面保存整份覆写，手改的东西下次点保存就没了。
 * 更糟的是"看起来关了、其实还开着"：界面没有开关，用户以为自己没开过。
 * ================================================================ */

/** 把 settings.js 也加载进已有沙箱（makeSandbox 默认只装 core/providers/dashboard）。 */
function loadSettings(S) {
  vm.runInContext(fs.readFileSync(path.join(RJ, 'settings.js'), 'utf8'), S.sandbox, { filename: 'settings.js' });
  return S;
}

t('渲染层（设置页）：工具裁剪**默认关闭** —— 配置里没有 maxTools 时开关必须是关的、上限框置灰', () => {
  const S = makeSandbox();
  loadSettings(S);
  const $ = S.sandbox.$;
  S.refs.LG.config = { port: 3091, providers: [] };
  S.refs.LG.renders.settings();
  assert.strictEqual($('#stMaxToolsOn').checked, false, '缺省（键不存在）必须是关闭 —— 引擎 DEFAULT_MAX_TOOLS = 0');
  assert.strictEqual($('#stMaxTools').disabled, true, '关闭时上限框要置灰，避免"填了数字却没生效"');
  assert.strictEqual($('#stMaxTools').value, '', '关闭时不应回填任何数字');

  // 配置里是 0 / 负数 / 非数字，引擎都会当成关闭（`Number.isFinite(raw) && raw > 0`），
  // 界面若显示成"已开启"就是在骗人。
  for (const weird of [0, -5, 'abc', null]) {
    S.refs.LG.config = { port: 3091, providers: [], maxTools: weird };
    S.refs.LG.renders.settings();
    assert.strictEqual($('#stMaxToolsOn').checked, false, `maxTools=${JSON.stringify(weird)} 应显示为关闭`);
  }
});

t('渲染层（设置页）：关掉工具裁剪必须**删键**（不是写 0），打开且留空写 128', () => {
  const S = makeSandbox();
  loadSettings(S);
  const $ = S.sandbox.$;
  S.refs.LG.config = { port: 3091, providers: [], maxTools: 128 };
  S.refs.LG.renders.settings();
  assert.strictEqual($('#stMaxToolsOn').checked, true, '128 应显示为已开启');
  assert.strictEqual($('#stMaxTools').value, '128', '已开启时要回填当前值');

  // ① 关掉 → 删键。写 0 与"没设过"在引擎里等价，但导出的配置会留下 `"maxTools": 0`，
  //    日后调整默认值就影响不到他（与 breaker 的处理同一套口径）。
  $('#stMaxToolsOn').checked = false;
  assert.strictEqual(S.sandbox.readSettingsInto(), true, '关掉开关必须算作"有改动"（否则不会提示保存）');
  assert.ok(!('maxTools' in S.refs.LG.config), '关掉时必须删键，实际配置：' + JSON.stringify(S.refs.LG.config));

  // ② 再打开、上限留空 → 128（与 placeholder 一致）
  $('#stMaxToolsOn').checked = true;
  $('#stMaxTools').value = '';
  S.sandbox.readSettingsInto();
  assert.strictEqual(S.refs.LG.config.maxTools, 128, '留空应写默认 128');

  // ③ 填具体数字 → 原样写回
  $('#stMaxTools').value = '64';
  S.sandbox.readSettingsInto();
  assert.strictEqual(S.refs.LG.config.maxTools, 64, '填了 64 就必须是 64');
});

t('渲染层（设置页）：工具裁剪上限越界必须拦下；开关关闭时不该因为上限框报错', () => {
  const S = makeSandbox();
  loadSettings(S);
  const $ = S.sandbox.$;
  S.refs.LG.config = { port: 3091, providers: [] };
  S.refs.LG.renders.settings();

  // 关闭状态下，上限框是置灰的，填了什么都无效 —— 不能因此拦住保存
  $('#stMaxToolsOn').checked = false;
  $('#stMaxTools').value = 'abc';
  assert.strictEqual(S.sandbox.validateSettingsInput(), '', '开关关闭时不得因为上限框报错');

  $('#stMaxToolsOn').checked = true;
  for (const bad of ['0', '-1', '2.5', 'abc', '2001']) {
    $('#stMaxTools').value = bad;
    assert.ok(/工具裁剪上限/.test(S.sandbox.validateSettingsInput()), `"${bad}" 必须被拒`);
  }
  $('#stMaxTools').value = '2000';
  assert.strictEqual(S.sandbox.validateSettingsInput(), '', '2000 是合法上界');
  $('#stMaxTools').value = '';
  assert.strictEqual(S.sandbox.validateSettingsInput(), '', '留空合法（= 128）');
});



/* ================================================================
 * 日志分级（renderer/js/logs.js 的 logLineClass）
 *
 * 2026-10-29 现场：amd 的 DeepSeek-V4.1-Flash 不认顶层 thinking 参数，
 * 配置里就写了 `quirks: ["drop-thinking"]` —— 网关按配置**在发送前**剥掉该参数，
 * 请求照常成功。可这行日志原来每个请求刷一遍、措辞又像报错，用户读成"一直报错"。
 * 修法有两半：引擎侧改文案 + 每供应商只记一次；界面侧必须把新文案判成正常色。
 * 这里钉住第二半 —— 分级函数是最容易被后续改文案悄悄改坏的一点。
 * ================================================================ */
t('渲染层（日志分级）：drop-thinking 说明行是正常色，不能显示成错误/警告', () => {
  const sb = {
    console, setTimeout, clearTimeout,
    JSON, Math, Number, String, Array, Object, RegExp, Date, Set, Map, Error, Promise,
    parseInt, parseFloat, isNaN, Boolean,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    window: {},
    $: () => null,
    $$: () => [],
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  // logs.js 末尾会把自己挂到 `LG.renders.logs` 上，所以先给一个最小 LG（真 core.js 太大，与本用例无关）。
  vm.runInContext('var LG = { renders: {}, logText: "", activeView: "logs" }; var LOG_MAX_LINES = 2000;', sb, { filename: 'log-stubs.js' });
  vm.runInContext(fs.readFileSync(path.join(RJ, 'logs.js'), 'utf8'), sb, { filename: 'logs.js' });
  const cls = (line) => vm.runInContext('logLineClass(' + JSON.stringify(line) + ')', sb);

  // 新文案（预期行为）→ 正常色
  assert.strictEqual(
    cls('upstream amd 不支持 extended thinking（配置已声明 drop-thinking） → 已剥掉顶层 thinking 参数后发送（预期行为，本供应商只在首次命中时记这一行）'),
    'ok',
    'drop-thinking 是配置声明的能力差异，剥掉后照常成功，不能出现在告警/错误里',
  );
  // 学习路径那行仍是真实的"白跑一次"→ 警告（别一起洗白）
  assert.strictEqual(
    cls('upstream amd 不支持 thinking（HTTP 200 + SSE 首事件错误） → 去掉顶层 thinking 参数后重试成功（已记住该家）'),
    'warn',
    '学习到之前白跑的那一次仍应提醒',
  );
  // 真失败必须还是红的
  assert.strictEqual(cls('[call] chat POST /v1/chat/completions status=502'), 'err');
});

/* ================================================================
 * 概览页「恢复」按钮（2026-10-29 用户需求）
 *
 * 用户原话："增加『恢复』按钮，用于一键将冷却或受限的供应商恢复正常使用"。
 * 冷却状态在引擎进程内存里，界面只能通过 gwAction('reset-cooldowns') 触达。
 *
 * 这条用例钉的是**界面这一半**（引擎那一半在 gateway.test.js）：
 *   ① 按钮真的存在并且挂上了监听 —— index.html 漏写 id 时 $() 拿到的是空桩，
 *      表现为"点了没反应"，而这正是本项目反复踩过的形态。
 *   ② 点它**不会**直接清 —— 先弹确认：清空等于忘掉"上游刚把我限流"，紧接着很可能再撞一次。
 *   ③ 确认后必须回显**恢复了几个**（全部本来就可用时，画面必须与"恢复了 12 个"不同）。
 *   ④ 失败必须说出来（静默 return = 用户分不清"没点到"与"真失败"）。
 * ================================================================ */
t('渲染层（概览页）：「恢复」按钮 → 二次确认 → 回显恢复数量；失败必须说出来', async () => {
  const S = makeSandbox();
  const { refs, captured, nodeById } = S;
  const calls = [];
  let nextResult = { ok: true, cleared: { accounts: 2, modelAccounts: 1, providers: 1, models: 0, notOffered: 3, egress: 0 } };
  S.sandbox.window.lgw = {
    gwAction: async (name) => { calls.push(name); return nextResult; },
    gwHealth: async () => ({ ok: true, accounts: [], guards: { loopGuard: 0, toolLoop: 0, roomy: 0, enabled: {} } }),
  };
  refs.LG.state = { gateway: { running: true, ready: true, port: 3091, configPath: 'C:\\x\\gateway.config.json' }, dataDir: 'C:\\x' };
  refs.LG.config = { providers: [], apiKey: 'k' };
  refs.LG.health = {
    ok: true,
    accounts: [{ key: 'amd#key1', provider: 'amd', id: 'key1', state: 'rate', remainMs: 40_000 }],
    guards: { loopGuard: 0, toolLoop: 0, roomy: 0, enabled: {} },
  };

  // ① 模板里必须有这个按钮（id 写错 = 点了没反应，且测试很难发现）
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(/id="btnResetCooldowns"/.test(html), 'index.html 必须存在 #btnResetCooldowns（恢复按钮）');

  refs.LG.initDashboard();
  const btn = nodeById.get('#btnResetCooldowns');
  assert.ok(btn, 'initDashboard 必须取到 #btnResetCooldowns');
  assert.strictEqual((btn._listeners.click || []).length, 1, '恢复按钮应恰好挂 1 个 click 监听');

  // ② 点一下：只弹确认，**不能**已经发出恢复请求
  btn._fire('click');
  assert.strictEqual(calls.length, 0, '确认之前不得真的执行恢复：' + JSON.stringify(calls));
  assert.ok(S.isModalOpen(), '应弹出确认框');
  const body = S.modalBody();
  assert.ok(/冷却/.test(body) && /熔断/.test(body), '确认框要说清会清掉哪些状态：' + body);
  assert.ok(/1/.test(body), '确认框要带上"当前有几个账户在冷却"：' + body);
  const foot = S.modalFoot();
  assert.strictEqual(foot.length, 2, '确认框应有 取消 / 确认恢复 两个按钮，实际 ' + foot.length);

  // ③ 确认 → 真的调用，并把数量回显出来
  foot[1]._fire('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(calls, ['reset-cooldowns'], '应调用一次 gwAction("reset-cooldowns")：' + JSON.stringify(calls));
  const okToast = captured.toasts[captured.toasts.length - 1];
  assert.ok(okToast && /账户冷却 2/.test(okToast.msg), '应回显账户冷却条数：' + JSON.stringify(captured.toasts));
  assert.ok(/模型级冷却 1/.test(okToast.msg) && /供应商熔断 1/.test(okToast.msg), '其余类别也要回显：' + okToast.msg);
  assert.ok(/ok/.test(okToast.cls), '成功提示应是正常色：' + okToast.cls);

  // ④ 全部本来可用（六个计数全 0）→ 必须说"没有冷却中的条目"，不能冒充"已恢复"
  nextResult = { ok: true, cleared: { accounts: 0, modelAccounts: 0, providers: 0, models: 0, notOffered: 0, egress: 0 } };
  captured.toasts.length = 0;
  btn._fire('click');
  S.modalFoot()[1]._fire('click');
  await new Promise((r) => setTimeout(r, 20));
  const zeroToast = captured.toasts[captured.toasts.length - 1];
  assert.ok(zeroToast && /没有任何冷却中的条目/.test(zeroToast.msg), '零恢复必须如实说：' + JSON.stringify(captured.toasts));

  // ⑤ 失败必须说出来（旧代码里这种 `{ok:false}` 常常被静默吞掉，界面表现为"点了没反应"）
  nextResult = { ok: false, error: '网关未运行' };
  captured.toasts.length = 0;
  btn._fire('click');
  S.modalFoot()[1]._fire('click');
  await new Promise((r) => setTimeout(r, 20));
  const errToast = captured.toasts[captured.toasts.length - 1];
  assert.ok(errToast && /恢复失败/.test(errToast.msg) && /网关未运行/.test(errToast.msg),
    '失败要带出主进程给的原因：' + JSON.stringify(captured.toasts));
  assert.ok(/err/.test(errToast.cls), '失败提示应是错误色：' + errToast.cls);
});


/* ================================================================
 * 使用帮助页底部的「关于与许可」（2026-11-04 用户要求）：
 *   "使用帮助页面最下方增加版权说明，许可协议，github地址等"
 *
 * 钉四件事：
 *   ① 版权行、许可协议、GitHub 仓库 / issues 两个入口都在；
 *   ② 许可必须与 package.json 的 license **一致**（界面写 MIT、元数据写别的 = 法律信息漂移）；
 *   ③ 每个外链都要 target="_blank" + rel="noopener" —— 主进程把 will-navigate
 *      拦下来交给系统浏览器，但 window.opener 仍会被远端页面拿到，而这个窗口挂着 preload 桥；
 *   ④ 版本号来自 st.app.version 而不是写死的字符串（升级后忘改版本是常见事故）。
 * ================================================================ */
t('渲染层（使用帮助）：底部必须有版权/许可/GitHub，外链一律 target=_blank + noopener，版本号走运行时', () => {
  const S = makeSandbox();
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

  const helpStart = html.indexOf('id="view-help"');
  assert.ok(helpStart > 0, 'index.html 必须存在 #view-help');
  const help = html.slice(helpStart);
  const aboutStart = help.indexOf('help-about');
  assert.ok(aboutStart > 0, '使用帮助页必须有一块 .help-about（关于与许可）');
  const about = help.slice(aboutStart, help.indexOf('</section>', aboutStart));

  // ① 内容
  assert.ok(/版权说明|版权/.test(about), '要写版权说明');
  assert.ok(new RegExp(String(pkg.author)).test(about),
    '版权行要带 package.json 里的作者（现在是 ' + pkg.author + '）：' + about.slice(0, 200));
  assert.ok(/MIT License/.test(about), '许可协议要写明 MIT License');
  assert.ok(/github\.com\/xuxue04403\/llm-gateway/.test(about), '要给出 GitHub 项目地址');
  assert.ok(/\/issues/.test(about), '要给出问题反馈入口');
  assert.ok(/AS IS|不附带任何明示或暗示的担保/.test(about), '要带免责声明');

  // ② 许可与元数据一致
  assert.strictEqual(String(pkg.license), 'MIT',
    'package.json 的 license 应与帮助页写的 MIT 一致，实际 ' + pkg.license);

  // ③ 外链安全属性
  const anchors = about.match(/<a\b[^>]*>/g) || [];
  assert.ok(anchors.length >= 3, '至少要有 LICENSE / 仓库 / issues 三个外链，实际 ' + anchors.length);
  for (const a of anchors) {
    assert.ok(/href="https:\/\//.test(a), '外链必须是 https 绝对地址：' + a);
    assert.ok(/target="_blank"/.test(a), '外链必须 target="_blank"：' + a);
    assert.ok(/rel="noopener"/.test(a), '外链必须 rel="noopener"（否则远端页面能拿到 window.opener）：' + a);
  }

  // ④ 版本号由运行时填充
  assert.ok(/id="helpVer"/.test(about), '版本号要有 id="helpVer" 供运行时填充');
  S.refs.LG.state = {
    app: { version: '9.9.9', name: 'LLM Gateway' },
    gateway: { running: false, ready: false, port: 3091, configPath: 'C:\\x\\gateway.config.json' },
    dataDir: 'C:\\x',
  };
  S.refs.LG.config = { providers: [], apiKey: 'k' };
  // 注意：`sandbox.renderTopbar` 在 makeSandbox 末尾被替换成空桩（别的用例不需要真跑顶栏），
  // 真实函数通过 __refs 暴露出来 —— 这里要验的是"版本号真的写进了 #helpVer"。
  S.refs.renderTopbar();
  const ver = S.nodeById.get('#helpVer');
  assert.ok(ver, 'renderTopbar 必须取到 #helpVer');
  assert.strictEqual(ver.textContent, 'v9.9.9', '帮助页版本号必须来自 st.app.version，实际 ' + ver.textContent);
});
