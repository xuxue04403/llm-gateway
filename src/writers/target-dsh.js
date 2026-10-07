// writers/target-dsh.js — 一键写入 dsh（DSH harness / DSH 桌面版）
//
// 实际写盘交给**引擎自己的 `--write-dsh`**（原样保留，含它那套逐层定位 + 原子写 +
// 首次备份 + YAML 转义 + 模型上限取最小值等全部既有行为）。本模块只做三件事：
//   ① 解析目标路径（尊重 DSH_HOME，与引擎一致）；
//   ② 生成**写入预览**（将要写什么、写到哪、现在是什么样）——旧界面点一下直接写，
//      用户看不到任何将要发生的事；
//   ③ 调用引擎并把 stdout/exit code 翻译成结构化结果。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const util = require('./util');
const models = require('./models');

const TARGET_ID = 'dsh';

// 显示名**只此一处**。卡片标题读的是 module.exports.name，预览弹窗标题读的是
// preview() 返回的 name —— 两处各写一份字面量的话迟早会走散（审计实测：
// 注册表写 'dsh' 而 preview 写 'dsh（DSH harness / DSH 桌面版）'，
// 同一张卡片点进去标题就变了）。这里用一个常量喂两边。
const DISPLAY_NAME = 'dsh（DSH harness / DSH 桌面版）';

function dshHome(ctx) {
  if (ctx && ctx.home) return path.join(ctx.home, '.dsh');       // 测试用：指向临时 home
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * dsh 的写入是交给**引擎**做的，而引擎读的是 `ctx.configPath` 指向的**配置文件里的** apiKey
 * —— 不是 `ctx.apiKey`。
 *
 * 生产路径上两者同源（`main.js` 的 writeCtx 从同一个文件读），但一旦分叉就会出事：
 * 实测 `ctx.apiKey` 是合法的 44 字符、而磁盘配置里是 `"abc"`（3 字符）时，
 * `preview.guard` 一条理由都不给、`apply.ok=true`，**引擎把 `'abc'` 写进了用户的
 * credentials.yaml**，覆盖掉原本可用的凭据 —— 之后所有 dsh 请求必然 401。
 * 引擎自己只拦"空"与"示例占位值"，不拦"过短"。
 *
 * 所以这里查的必须是**引擎会实际使用的那把 Key**。
 */
function effectiveKey(ctx) {
  try {
    const raw = util.readText(ctx && ctx.configPath);
    if (raw) {
      const parsed = util.parseJsonObject(raw);
      const k = parsed.ok && parsed.value ? parsed.value.apiKey : undefined;
      if (typeof k === 'string') return k;
    }
  } catch (_) { /* 读不到就退回 ctx */ }
  return (ctx && ctx.apiKey) || '';
}

function paths(ctx) {
  const home = dshHome(ctx);
  return {
    home,
    settings: process.env.DSH_SETTINGS || path.join(home, 'settings.yaml'),
    credentials: process.env.DSH_CREDENTIALS || path.join(home, '.credentials.yaml'),
    profilesDir: path.join(home, 'profiles'),
  };
}

/**
 * 找 dsh 的 profile 补丁文件（`profiles/<name>/cordis.patch.yml`）。
 *
 * 为什么关心它：dsh 0.1.7+ 把 `settings.yaml` 变成了**一次性导入源** —— 启动时
 * `dsh-settings` 的 importLegacyDocument() 把该文件整体 rename 成 `.imported`，
 * 再把每个 section 用 `mergeLayers`（**递归稀疏合并**，不是整段替换）并进 profile。
 * 也就是说：
 *   · 我们写 settings.yaml 仍然是**有效**的写入方式（下一次 dsh 启动即生效）；
 *   · 但合并结果落在 profile 补丁里，用户想核对"到底进没进去"要看那个文件。
 * 这两个事实都必须告诉用户，否则界面说的和磁盘上的现象对不上。
 */
function findProfilePatch(ctx) {
  const p = paths(ctx);
  try {
    if (!fs.existsSync(p.profilesDir)) return '';
    for (const name of fs.readdirSync(p.profilesDir)) {
      const f = path.join(p.profilesDir, name, 'cordis.patch.yml');
      if (fs.existsSync(f)) return f;
    }
  } catch (_) { /* 忽略 */ }
  return '';
}

/** profile 补丁里是否已有 `gateway:` 供应商条目（缩进 8）。 */
function profileHasGateway(patchPath) {
  if (!patchPath) return false;
  const text = util.readText(patchPath);
  return /^\s{8}gateway:\s*$/m.test(text);
}

/**
 * 线协议与 baseURL 由引擎按 cfg.clientProfile 决定：
 *   claude → anthropic-messages，baseURL 不含 /v1（Anthropic SDK 自拼 /v1/messages）
 *   其余   → openai-completions，baseURL 带 /v1
 * 这里复刻同一规则，只为"预览"用；真正写盘仍以引擎为准。
 */
function wireOf(cfg, port) {
  const clientProfile = String((cfg && cfg.clientProfile) || '').trim();
  const api = clientProfile === 'claude' ? 'anthropic-messages' : 'openai-completions';
  const baseURL = api === 'anthropic-messages' ? `http://127.0.0.1:${port}` : `http://127.0.0.1:${port}/v1`;
  return { clientProfile, api, baseURL };
}

/** 在 settings.yaml 里找 `    gateway:` 块（缩进 4），返回 {found, text, line}。 */
function findGatewayBlock(text) {
  const lines = String(text || '').split('\n');
  const at = (i) => lines[i].replace(/\r$/, '');
  let pi = -1;
  let piEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^llm-pi-ai:\s*$/.test(at(i))) {
      pi = i;
      piEnd = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = at(j);
        if (l.trim() !== '' && !/^\s/.test(l)) { piEnd = j; break; }
      }
      break;
    }
  }
  if (pi < 0) return { found: false, text: '', line: -1 };
  let g = -1;
  for (let i = pi + 1; i < piEnd; i++) {
    if (/^ {4}gateway:\s*$/.test(at(i))) { g = i; break; }
  }
  if (g < 0) return { found: false, text: '', line: -1 };
  let gEnd = g + 1;
  for (; gEnd < piEnd; gEnd++) {
    const l = at(gEnd);
    if (l.trim() === '') continue;
    if (/^ {0,4}\S/.test(l)) break;
  }
  while (gEnd > g + 1 && at(gEnd - 1).trim() === '') gEnd--;
  return { found: true, text: lines.slice(g, gEnd).join('\n'), line: g + 1 };
}

/** 检测：dsh 是否装过 / 配置在哪 / 当前有没有网关注册。 */
function detect(ctx) {
  const p = paths(ctx);
  const settingsExists = util.exists(p.settings);
  const block = settingsExists ? findGatewayBlock(util.readText(p.settings)) : { found: false, text: '', line: -1 };
  const credsText = util.readText(p.credentials);
  const hasKey = /^\s*DSH_GATEWAY_API_KEY\s*:/m.test(credsText);
  const patch = findProfilePatch(ctx);
  const inProfile = profileHasGateway(patch);
  // 实际会写出的协议与 baseURL —— 由配置里的 clientProfile 决定。这是 dsh 与其它客户端
  // 最不同的一点（别的家是固定形态，dsh 是"跟着全局仿真走"），必须显示出来，
  // 否则用户在界面上看不到自己到底会得到 anthropic 还是 openai。
  const wire = wireOf(ctx.config || {}, ctx.port);
  return {
    id: TARGET_ID,
    installed: fs.existsSync(p.home),
    evidence: [
      `home：${p.home}`,
      settingsExists
        ? `settings.yaml 存在（${fs.statSync(p.settings).size} B）`
        : 'settings.yaml 不存在 —— 正常：dsh 启动时会把它导入 profile 并改名为 .imported，写入时会新建',
      inProfile ? `已注册 gateway 提供商（在 ${path.basename(path.dirname(patch))}/cordis.patch.yml）` : '尚未注册 gateway 提供商',
      hasKey ? '统一 Key 已在 .credentials.yaml 的 refs 里' : '.credentials.yaml 里还没有 DSH_GATEWAY_API_KEY',
    ],
    configPaths: [p.settings, p.credentials].concat(patch ? [patch] : []),
    wire,
    current: { block: block.text, hasKey, profilePatch: patch, inProfile, ...wire },
  };
}

/**
 * YAML 单引号标量的转义，**逐字复制自引擎的 writeDshConfig**。
 *
 * 为什么必须一模一样：预览的全部价值就是"显示的就是将要写进去的"。引擎侧用 yamlQuote
 * 把模型名里的换行压掉、单引号翻倍；预览若只做 `'${m}'`，那么一个含换行的模型名会让
 * 预览显示成"闭合了引号、插入了伪键"的假 YAML —— 而实际落盘的是安全的那份。
 * 于是"预览"从可信凭据变成了误导材料（实测确认过这个差异）。
 */
const yamlQuote = (s) => `'${String(s).replace(/[\r\n]+/g, ' ').replace(/'/g, "''")}'`;

/** 生成写入预览：目标文件 + 将要出现的 gateway 段 + 现有段（若有）。 */
function preview(ctx) {
  const cfg = ctx.config || {};
  const p = paths(ctx);
  const wire = wireOf(cfg, ctx.port);
  const collected = models.collectModels(cfg);
  const names = collected.map((m) => m.id);
  const byName = new Map(collected.map((m) => [m.id, m]));
  const guard = [];
  const keyProblem = util.apiKeyProblem(effectiveKey(ctx));
  if (keyProblem) guard.push(keyProblem + '（dsh 的写入由引擎执行，引擎读的就是配置文件里这把 Key）');
  if (names.length === 0) guard.push('没有任何启用供应商声明模型 —— 引擎会拒绝写入');
  const settingsText = util.readText(p.settings);
  const block = findGatewayBlock(settingsText);
  const patch = findProfilePatch(ctx);
  const inProfile = profileHasGateway(patch);

  // 以下行的形状与缩进**必须与引擎 writeDshConfig 的输出逐字一致**（见 yamlQuote 的注释）。
  // tests/edge.test.js 里有一条断言：预览的 block 与引擎真实落盘的 block 必须完全相同。
  const compatLines = wire.api === 'anthropic-messages'
    ? '\n          compat:\n            allowEmptySignature: true'
    : '';
  const inputLines = (m) => ((byName.get(m) || {}).vision
    ? '\n          input:\n            - text\n            - image'
    : '');
  const modelLines = names.map((m) => {
    const rec = byName.get(m) || {};
    const ctxWin = rec.contextWindow || 1024000;
    const maxTok = rec.maxTokens;
    return `        - id: ${yamlQuote(m)}\n          name: ${yamlQuote(m)}\n          contextWindow: ${ctxWin}`
      + (maxTok ? `\n          maxTokens: ${maxTok}` : '')
      + `\n          reasoningEfforts:\n            off: null\n            low: low\n            medium: medium\n            high: high\n            max: max${inputLines(m)}${compatLines}`;
  }).join('\n');

  const willWrite = `    gateway:\n      displayName: DSH Model Gateway\n      apiKeyEnv: DSH_GATEWAY_API_KEY\n      api: ${wire.api}\n      baseURL: ${wire.baseURL}\n      models:\n${modelLines}`;

  return {
    id: TARGET_ID,
    name: DISPLAY_NAME,
    method: 'engine',
    summary: `注册 gateway 提供商（${names.length} 个模型，协议 ${wire.api}）`,
    guard,
    // 预览里的 Key 一律打码
    apiKeyMasked: util.maskValue(ctx.apiKey),
    port: ctx.port,
    wire,
    models: names,
    files: [
      {
        path: p.settings,
        action: block.found ? 'replace' : (util.exists(p.settings) ? 'insert' : 'create'),
        exists: util.exists(p.settings),
        before: null,
        after: willWrite,
        note: block.found
          ? `将替换现有的 gateway 段（当前第 ${block.line} 行起）`
          : '将在 llm-pi-ai.providers 下插入 gateway 段',
      },
      {
        path: p.credentials,
        action: /^\s*DSH_GATEWAY_API_KEY\s*:/m.test(util.readText(p.credentials)) ? 'replace' : (util.exists(p.credentials) ? 'insert' : 'create'),
        exists: util.exists(p.credentials),
        before: null,
        after: 'refs:\n  DSH_GATEWAY_API_KEY: \'<你的统一 Key>\'',
        note: '只更新这一个键，其它凭据（DEEPSEEK / KINGROUTER 等）一律不动',
      },
    ].concat(patch ? [{
      path: patch,
      action: inProfile ? 'replace' : 'insert',
      exists: true,
      before: null,
      after: '（这一步由 dsh 自己完成，不是本程序直接写）',
      note: 'dsh 下次启动时会把 settings.yaml 导入这里：它是**按层合并**的，只覆盖 llm-pi-ai.providers.gateway，'
        + '你已有的其它供应商（kingrouter / opencode-go …）不受影响；导入后 settings.yaml 会被改名为 .imported',
    }] : []),
    warnings: [
      '写入后**必须重启 dsh**（`dsh web`）才会生效 —— dsh 只在启动时导入 settings.yaml。',
      'dsh 启动时会把这个文件改名成 settings.yaml.imported（它自己的设计，不是本程序删的）。所以写完看不到 settings.yaml 是正常的。',
      inProfile ? `profile 里已有 gateway 提供商，本次是覆盖更新（${patch}）` : '',
    ].filter(Boolean),
  };
}

/**
 * 执行写入：spawn 引擎的 `--write-dsh`。
 *
 * ⚠ **必须显式传 `--settings` / `--credentials`**（本次实测踩到的坑）：引擎在不传这两个参数时
 * 靠 `DSH_HOME || os.homedir()/.dsh` 自己解析路径，而本模块的 detect/preview 用的是
 * `paths(ctx)`。两者一旦分叉，就会出现"预览说的是 A 文件、实际写的是 B 文件"——
 * 更糟的是在测试/多实例场景下会**写进用户的真实主目录**。同一条路径必须由同一个函数产出。
 */
function apply(ctx) {
  // 与 preview 的 guard 同源。dsh 的写入是交给**引擎**做的，而引擎按配置文件里的 apiKey
  // 行事（不看 ctx.apiKey）—— 生产路径上两者同源所以一致，但 apply 被单独调用时就可能
  // "预览拦下了、写入却照做"。这里显式拦一道，保证两条路径行为一致。
  const keyProblem = util.apiKeyProblem(effectiveKey(ctx));
  if (keyProblem) return Promise.resolve({ ok: false, errors: [keyProblem], files: [] });

  const p = paths(ctx);
  const mjs = ctx.enginePath;
  return new Promise((resolve) => {
    if (!mjs || !util.exists(mjs)) {
      return resolve({ ok: false, output: '', errors: ['找不到网关引擎：' + mjs], files: [] });
    }
    let child;
    try {
      child = spawn(ctx.nodeExe, [
        mjs, '--write-dsh',
        '--config', ctx.configPath,
        '--settings', p.settings,
        '--credentials', p.credentials,
        '--port', String(ctx.port),
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { DSH_GATEWAY_CONFIG: ctx.configPath }, ctx.nodeEnv || {}),
      });
    } catch (e) {
      return resolve({ ok: false, output: '', errors: ['启动写入进程失败：' + (e && e.message ? e.message : e)], files: [] });
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* 忽略 */ }
      resolve({ ok: false, output: out, errors: ['写入超时（60 秒）'], files: [] });
    }, 60000);
    if (child.stdout) child.stdout.on('data', (c) => { out += c; });
    if (child.stderr) child.stderr.on('data', (c) => { out += c; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: out, errors: [String(e && e.message ? e.message : e)], files: [] });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // 只有引擎确实写出文件才算成功——"退出码 0 但目标不存在"必须报出来，
      // 否则界面会说"已写入"而用户什么都看不到。
      const missing = [p.settings, p.credentials].filter((f) => !util.exists(f));
      const errs = [];
      if (code !== 0) errs.push('引擎退出码 ' + code);
      if (missing.length) errs.push('引擎报告成功，但这些文件不存在：' + missing.join('、'));
      // ⚠ 必须把备份路径一并返回。
      // 旧实现只回 `files`，于是 `write:apply` 归一化后 `backups: []`，
      // 界面上**看不到备份在哪** —— 而 .bak-gateway 其实真的生成了
      //（实测 `~/.dsh/settings.yaml.bak-gateway`、`.credentials.yaml.bak-gateway` 都在）。
      // 用户想回退时找不到文件，只能靠猜。
      const backups = errs.length === 0
        ? [p.settings, p.credentials]
          .map((f) => util.backupInfo(f))
          .filter(Boolean)
          .map((b) => b.path)
        : [];
      resolve({
        ok: errs.length === 0,
        output: out.trim(),
        errors: errs,
        files: errs.length === 0 ? [p.settings, p.credentials] : [],
        backups,
        nextSteps: errs.length === 0 ? [
          '重启 dsh（关掉再启动 DSH App，或重启 `dsh web`）—— dsh 只在启动时导入 settings.yaml。',
          '重启后在 dsh 的模型选择器里会多出一个 `gateway` 提供商，里面是本网关的全部模型。',
          `核对是否生效：重启后看 ${p.profilesDir}\\<profile>\\cordis.patch.yml 里的 llm-pi-ai.providers.gateway；`
            + 'settings.yaml 会被 dsh 自己改名成 settings.yaml.imported（这是它的设计，不是丢失）。',
          '前提：本网关必须处于运行状态，否则 dsh 调用 gateway 提供商会连接失败。',
        ] : [],
      });
    });
  });
}

function restore(ctx) {
  const p = paths(ctx);
  const results = [];
  for (const f of [p.settings, p.credentials]) {
    if (util.backupInfo(f)) results.push(Object.assign({ file: f }, util.restore(f)));
  }
  return {
    ok: results.length > 0 && results.every((r) => r.ok),
    results,
    errors: results.length === 0 ? ['没有找到由本程序写入时留下的备份'] : results.filter((r) => !r.ok).map((r) => r.file + '：' + r.error),
  };
}

module.exports = { id: TARGET_ID, name: DISPLAY_NAME, detect, preview, apply, restore, paths, wireOf, findGatewayBlock, baseUrlHint: '由客户端仿真决定' };
