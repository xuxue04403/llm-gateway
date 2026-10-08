// writers/util.js — 一键写入的公共底座（原子写、备份、恢复、TOML 定点改）
//
// 三条铁律（都是被真实事故逼出来的）：
//   ① **写前必须备份，备份失败就中止**。这些文件里装着用户已有的模型配置，覆盖不可逆。
//   ② **原子写**（临时文件 + rename）。半截 JSON/TOML 会让客户端下次直接起不来。
//   ③ **只动自己那一小块**。绝不整份重写别人的配置文件——用户在里面还有很多别的设置。
'use strict';

const fs = require('fs');
const path = require('path');
const { maskSecretsFull } = require('../logger');

const BACKUP_SUFFIX = '.bak-llmgateway';

/* ---------------- 读 ---------------- */

function exists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}

/** 读 JSON；文件不存在返回 fallback；解析失败返回 { __parseError }。 */
function readJson(p, fallback) {
  if (!exists(p)) return fallback === undefined ? {} : fallback;
  const t = readText(p);
  if (!t.trim()) return fallback === undefined ? {} : fallback;
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return { __parseError: '根节点不是对象' };
  } catch (e) {
    return { __parseError: e && e.message ? e.message : String(e) };
  }
}

/* ---------------- 写 ---------------- */

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * 原子写。第一次写某个文件时留一份 `<file>.bak-llmgateway`（已存在则不覆盖，
 * 保留最原始的那份）。
 *
 * ⚠ **铁律：目标已存在时，必须先能把它读回来，否则一律中止。**
 * 为什么：各目标的流程都是"读原文件 → 合成新文本 → 写"，而 `readText`/`readJson` 在
 * 读失败时是**静默返回空串/空对象**的（为了容忍"文件不存在"这种正常情况）。于是当文件
 * 存在但读不出来（ACL 拒绝、被独占锁定、磁盘错误）时，合成出来的"新文本"里只剩本程序
 * 受管的那几个键，用户原有的 language / enabledPlugins / statusLine / mcp_servers 全部消失
 * —— 而且 apply 还会报 ok:true。实测确认过这条路径。
 * 在这里兜底：读不回来就不写。这一处闸门覆盖全部目标。
 *
 * @returns {{ok:boolean, backup?:string, error?:string, skipped?:boolean}}
 */
function writeAtomic(file, text) {
  // ⚠ backup 必须在 try 之外声明：写入失败（rename 被独占锁定等）时备份**已经生成**了，
  // 若把它丢在 try 里，throw 之后 catch 只能回 {ok:false,error} —— 界面就拿不到备份路径。
  // 而"写入失败"恰恰是用户最需要知道备份在哪的时候（否则他可能把那份唯一备份当垃圾删掉）。
  let backup = '';
  try {
    ensureDir(file);
    if (exists(file)) {
      try {
        fs.readFileSync(file);           // 只验证可读性，内容用不到
      } catch (e) {
        return {
          ok: false,
          error: '目标文件已存在但读不出来（' + (e && e.message ? e.message : e) + '），'
            + '已中止写入以免覆盖掉你原有的内容。请检查文件权限/是否被其它程序占用。',
        };
      }
      const bak = file + BACKUP_SUFFIX;
      if (!exists(bak)) {
        try {
          fs.copyFileSync(file, bak);
          backup = bak;
        } catch (e) {
          // 备份失败 → 中止（铁律①）
          return { ok: false, error: '备份失败，已中止写入：' + (e && e.message ? e.message : e) };
        }
      }
    }
    // 临时名带随机后缀：只带 pid 时，**同进程内并发写同一个文件**会共用同一个临时路径
    // （rename 成功但内容是最后一次写入，返回值还都是 ok:true）。跨进程因 pid 不同不会撞，
    // 所以这是个潜伏的坑 —— 加个随机后缀的成本是零。
    const tmp = file + '.tmp-llmgateway-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      // rename 失败（目标被独占锁定等）时**必须清掉临时文件**：
      // 它里面是刚合成的完整内容（含明文密钥），留在用户目录里既是垃圾也是泄漏面。
      try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
      throw e;
    }
    return { ok: true, backup };
  } catch (e) {
    // 带上 backup：失败路径上它通常非空（备份先于写入生成），必须让调用方/界面看到
    return { ok: false, backup, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 读取"将要被改写的现有文件"，**区分"不存在"与"读不到"**。
 * 调用方应当在 `ok:false` 时中止 —— 这条给的是精确原因（比 writeAtomic 的兜底更好读）。
 *
 * @returns {{ok:boolean, exists:boolean, text:string, error?:string}}
 */
function readTarget(file) {
  try {
    if (!exists(file)) return { ok: true, exists: false, text: '' };
    return { ok: true, exists: true, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { ok: false, exists: true, text: '', error: e && e.message ? e.message : String(e) };
  }
}

/** 解析 JSON 对象；返回 { ok, value, error }（与 readJson 的 __parseError 约定并存）。 */
function parseJsonObject(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return { ok: true, value: {} };
  let v;
  try {
    v = JSON.parse(t);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '根节点不是对象' };
  return { ok: true, value: v };
}

/** 从备份恢复（并把当前内容另存为 `.bak-llmgateway-before-restore`）。 */
function restore(file, suffixes) {
  const info = backupInfo(file, suffixes);
  if (!info) return { ok: false, error: '没有可用的备份：' + file + '（找过 ' + candidateSuffixes(suffixes).join(' / ') + '）' };
  // 恢复前先把"当前内容"留一份 —— 用户可能想反悔（恢复错了备份）
  let before = '';
  if (exists(file)) {
    before = file + '.bak-llmgateway-before-restore';
    try {
      fs.copyFileSync(file, before);
    } catch (e) {
      return {
        ok: false,
        error: '恢复前无法备份当前内容，已中止（不动原文件）：' + (e && e.message ? e.message : e),
      };
    }
  }
  // ⚠⚠ 必须走 **tmp + rename**，不能用 `copyFileSync(备份, 目标)`。
  //
  // copyFile 是**就地覆盖**：它先把目标截断再写入，中途失败（ENOSPC / EIO / 权限 / 被占用）
  // 会把用户的配置留成**半截** —— 既不是原文、也不是备份，而且通常已经不是合法 JSON/TOML。
  // 恢复是用户最后的安全网，这张网自己撕了文件就真没救了。
  // 实测（审计脚本 audit-restore-atomic）：模拟 ENOSPC 后 settings.json 只剩
  // `{"env": {"ANTHROPIC_AU`（30 字节，JSON.parse 报 Unterminated string）。
  // rename 在同一文件系统内是原子的 —— 要么全换、要么完全不换。
  const tmp = file + '.tmp-llmgateway-restore-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
  try {
    fs.copyFileSync(info.path, tmp);
    fs.renameSync(tmp, file);
    return { ok: true, from: info.path, before };
  } catch (e) {
    // 临时文件里是用户的完整配置，失败时必须清掉（既是垃圾也是泄漏面）
    try { if (exists(tmp)) fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    return { ok: false, before, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 备份文件的候选后缀。
 *
 * `.bak-gateway` 是**引擎自己的** `--write-dsh` 留在 `settings.yaml` / `.credentials.yaml`
 * 旁边的后缀（见 model-gateway.mjs 的 writeFileAtomicDsh）。dsh 目标的写入是交给引擎做的，
 * 所以它的备份只能按这个后缀去找 —— 旧实现只认 `.bak-llmgateway`，导致界面上 dsh 的
 * 「恢复备份」**永远失败**（磁盘上明明躺着备份，实测确认）。
 */
const BACKUP_SUFFIXES = [BACKUP_SUFFIX, '.bak-gateway'];

function candidateSuffixes(suffixes) {
  if (!suffixes) return BACKUP_SUFFIXES;
  return Array.isArray(suffixes) ? suffixes : [suffixes];
}

function backupInfo(file, suffixes) {
  for (const suf of candidateSuffixes(suffixes)) {
    const bak = file + suf;
    if (!exists(bak)) continue;
    try {
      const st = fs.statSync(bak);
      return { path: bak, suffix: suf, size: st.size, mtime: st.mtime.toISOString() };
    } catch (_) { /* 试下一个 */ }
  }
  return null;
}

/* ---------------- 脱敏与展示 ---------------- */

const SENSITIVE_KEY_RE = /key|token|secret|password|authorization|cookie/i;

/**
 * 递归脱敏：键名像密钥的**整值抹掉**，字符串值里"确实是密钥"的也抹掉。
 *
 * 这里刻意**不留前缀**（不像 maskValue 那样显示 `sk-a…`）：redact 的产物是"写入预览的
 * diff"，那个框会被用户截图、贴到群里求助。留 4 个字符对排查没帮助，却实实在在泄露了一截。
 * 需要"让你认出是哪把 Key"的场合用 maskValue（只出现在你自己的界面上）。
 *
 * ⚠ 判据是**已知密钥形态 + 键名**，不再用"长度 ≥20 且无空格"这种启发式。
 * 实测误伤：`claude-3-5-sonnet-20241022` → `<masked:26>`、`gpt-4o-mini-2024-07-18` →
 * `<masked:22>`、`model_reasoning_effort` → `<masked:22>`、ISO 时间戳 → `<masked:24>`；
 * 于是 opencode 预览里的 `"name"` 和 claude-code 的 `ANTHROPIC_MODEL` 全变成打码值，
 * 预览彻底没法看。同一批串交给 logger.maskSecretsFull 是**原样放行**的 ——
 * 误伤只来自这里那份重复且更粗的启发式。现在统一走 logger，两处口径一致。
 */
function redact(value, depth) {
  const d = depth || 0;
  if (d > 8) return '<deep>';
  if (value == null) return value;
  if (typeof value === 'string') {
    // URL 里的 user:password@ 先抠掉：它"长得像 URL"，其它规则都会放过它
    const noCred = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1<masked-userinfo>@');
    return maskSecretsFull(noCred);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((x) => redact(x, d + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '<masked>' : redact(value[k], d + 1);
    }
    return out;
  }
  return String(value);
}

/** 带前缀的轻量打码（仅用于"你自己的界面"上显示当前值，便于辨认是哪一把）。 */
function maskValue(v) {
  if (v == null) return v;
  const s = String(v);
  if (s.length <= 6) return '<masked>';
  return s.slice(0, 4) + '…<masked:' + s.length + '>';
}

/** 生成给人看的逐行 diff（只标注增删改，不做 LCS 对齐——这些文件都很小）。 */
function simpleDiff(before, after, label) {
  const a = String(before == null ? '' : before).split(/\r?\n/);
  const b = String(after == null ? '' : after).split(/\r?\n/);
  const setA = new Map();
  a.forEach((l, i) => { if (!setA.has(l)) setA.set(l, i); });
  const setB = new Set(b);
  const out = [];
  const seenB = new Set();
  for (let i = 0; i < b.length; i++) {
    const line = b[i];
    if (seenB.has(line)) continue;
    seenB.add(line);
    if (!setA.has(line)) out.push({ op: 'add', line, lineNo: i + 1 });
  }
  const seenA = new Set();
  for (let i = 0; i < a.length; i++) {
    const line = a[i];
    if (seenA.has(line)) continue;
    seenA.add(line);
    if (!setB.has(line)) out.push({ op: 'del', line, lineNo: i + 1 });
  }
  return { label: label || '', before, after, entries: out };
}

/* ---------------- 最小 TOML 定点编辑 ---------------- *
 * 只支持这一种形状（够用且不会误伤）：
 *     key = value                     ← 顶层标量
 *     [section]                       ← 表头
 *     [section.sub]                   ← 子表头
 *     key = value                     ← 表内标量
 * 不支持数组表 [[x]] / 内联表作为**目标**，但它们出现在别处也不会被动到。
 * ------------------------------------------------------------------ */

/**
 * TOML 词法扫描（只做我们关心的那部分）：逐**字符**走过每一行，正确区分
 * 基本串 `"…"` / 字面串 `'…'` / 多行串 `"""…"""` / `'''…'''` / 注释 `#`。
 *
 * 产出：
 *   `inMultiAt[i]`  —— 第 i 行**开始时**是否处于多行串内部
 *   `codeOf[i]`     —— 去掉注释与**字符串内容**后的"代码骨架"（列位置保留为空格）
 *   `headers`       —— 真正的表头（跳过注释与所有字符串内容）
 *   `endsInMulti`   —— 文件结束时仍在多行串内部（= 未闭合，语法错误）
 *
 * 为什么要字符级扫描：旧实现是"数 `"""` / `'''` 出现次数的奇偶"，而
 *   `a = """x'''y"""`
 * 里的 `'''` 出现在 `"""` **内部**、只是普通字符，一数就成了"奇数个 `'''`"——
 * 于是一份**合法**的 TOML 被判成"未闭合的多行字符串"，codex 的写入被彻底堵死
 * （实测：250 轮差分模糊里被它拦下的 29 例，经 tomllib 判定 **29/29 全是误报**）。
 */
function tomlLex(lines) {
  const inMultiAt = [];
  const codeOf = [];
  const headers = [];
  let inMulti = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = String(lines[i] == null ? '' : lines[i]);
    inMultiAt.push(inMulti);

    if (inMulti) {
      const end = raw.indexOf(inMulti);
      if (end >= 0) {
        inMulti = null;
        codeOf.push(' '.repeat(end));
      } else {
        codeOf.push('');
      }
      continue;
    }

    let out = '';
    let j = 0;
    while (j < raw.length) {
      const c = raw[j];
      if (c === '#') break;                       // 注释：本行剩余全部忽略
      if (c === '"' || c === "'") {
        const trip = c.repeat(3);
        if (raw.startsWith(trip, j)) {
          const close = raw.indexOf(trip, j + 3);
          if (close < 0) { inMulti = trip; out += ' '.repeat(raw.length - j); j = raw.length; break; }
          out += ' '.repeat(close + 3 - j);
          j = close + 3;
          continue;
        }
        if (c === '"') {
          let k = j + 1;
          while (k < raw.length) {
            if (raw[k] === '\\') { k += 2; continue; }
            if (raw[k] === '"') { k++; break; }
            k++;
          }
          const end = Math.min(k, raw.length);
          out += ' '.repeat(end - j);
          j = end;
        } else {
          const close = raw.indexOf("'", j + 1);
          const end = close < 0 ? raw.length : close + 1;
          out += ' '.repeat(end - j);
          j = end;
        }
        continue;
      }
      out += c;
      j++;
    }
    codeOf.push(out);

    const m = /^\s*(\[\[?)\s*([^[\]]+?)\s*\]\]?\s*$/.exec(stripTomlComment(raw));
    // ⚠ 表头名必须从**只去注释的原文**里取，不能用上面那个把字符串内容抹成空格的 `out`。
    // 因为表头里的引号是**语法**而不是字符串值：`["model_providers"."llmgateway"]`
    // 经 `out` 之后变成 `[               .              ]`，名字整个丢了 ——
    // 于是既认不出这是哪张表，也判不出重复声明。
    // 用原文匹配仍然安全：多行字符串内部的行在函数开头就 `continue` 掉了，
    // 而 `name = "a[b]"` 这类行不以 `[` 开头，正则不匹配。
    //
    // `name` 是原始写法（报错时给人看），`key` 是**归一化后的表标识**（判断"是不是同一张表"用）：
    // TOML 里 `[a.b]`、`[a . b]`、`["a"."b"]` 是**同一张表**，但原始字符串各不相同，
    // 只比原始串就会漏判重复声明（实测：upsert 会再追加一张同名表 → 整份 config.toml
    // 变成非法，用户自己的 provider / mcp_servers / projects 一起失效，而程序报"写入成功"）。
    if (m) headers.push({ line: i, name: m[2].trim(), key: tomlHeaderKey(m[2]), isArray: m[1] === '[[' });
  }
  return { inMultiAt, codeOf, headers, endsInMulti: inMulti };
}

/**
 * 去掉一行里的 TOML 注释，但**保留引号内的内容**（含 `#`）。
 *
 * 与 tomlLex 里把字符串抹成空格的逻辑不同：那个用于"找键"，这个用于"读表头名"。
 * 表头里的引号是语法，抹掉就等于把名字丢了。
 */
function stripTomlComment(line) {
  const s = String(line == null ? '' : line);
  let quote = null;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      out += c;
      if (c === quote) { quote = null; }
      else if (c === '\\' && quote === '"') { i++; out += s[i] == null ? '' : s[i]; }
      continue;
    }
    if (c === '#') break;
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

/**
 * 把 TOML 表头原文归一化成**唯一的表标识**。
 *
 * 为什么必须有这一步（2026-09-30 审计实测）：
 * TOML 里下面三种写法指的是**同一张表** ——
 *     [model_providers.llmgateway]
 *     [model_providers . llmgateway]        ← 点号两边可以有空白
 *     ["model_providers"."llmgateway"]      ← 分段可以用引号包起来
 * 而旧实现拿**原始字符串**比较，于是 `[model_providers . llmgateway]` 认不出
 * 已经存在的 `[model_providers.llmgateway]`，upsert 会**再追加一张同名表** ——
 * 整份 config.toml 变成非法（`Cannot declare ('model_providers','llmgateway') twice`），
 * 用户自己的 provider / mcp_servers / projects 一起失效，而程序会报"写入成功"。
 * 差分测试（349 个 tomllib 判合法的 before 文件）实测有 3 例踩到，且自检 tomlValidate 放过。
 *
 * 实现：按 `.` 分段（引号内的点号不分段），每段去空白、剥引号，再用 JSON 编码后拼起来。
 * 用 JSON 编码而不是直接 join('.')，是为了让 `["a.b"]`（一个键叫 `a.b`）与
 * `[a.b]`（两层的 a → b）保持**可区分** —— 它们在 TOML 里确实是不同的表。
 */
function tomlHeaderKey(raw) {
  const s = String(raw == null ? '' : raw);
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      // TOML **基本字符串**里的 `\` 是转义符：`\"` 表示一个引号字符，不是"段结束"。
      // 不处理的话 `["a"."llm\"gateway"]` 会被切成错误的分段（`llm\` + 后面被当成新段），
      // 于是它与**字面量**写法 `'llm"gateway'`（同一张表）归一化结果不同 ——
      // 同一张表被认成两张，upsert 会追加一张重复表。
      // （审计实测：`"llm\"gateway"` 旧实现得到 `"llm\\gateway"`。）
      if (c === '\\' && quote === '"') {
        const n = s[i + 1];
        if (n == null) { cur += '\\'; continue; }
        i++;
        const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\' };
        // 未知转义（TOML 里本就不合法）原样保留，别把内容吃掉
        cur += Object.prototype.hasOwnProperty.call(ESC, n) ? ESC[n] : ('\\' + n);
        continue;
      }
      if (c === quote) { quote = null; if (c === '"' && s[i + 1] === '"') i++; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '.') { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((x) => x !== '').map((x) => JSON.stringify(x)).join('.');
}

/** 真正的表头行（跳过注释与字符串内容）。 */
function tomlScanHeaders(lines) {
  return tomlLexMemo(lines).headers;
}

/**
 * `tomlLex` 的**记忆化**：同一份 lines 数组只词法扫描一次。
 *
 * ⚠ 这不是"顺手优化一下"，是修一个**实测把主进程冻住 33 秒**的性能 bug。
 *
 * `forEachCodeLine()` 每次调用都会重新 `tomlLex(lines)`（整份文件扫一遍），
 * 而 `tomlValidate()` 的"同一张表内键重复"检查对**每张表**都要调一次它 ——
 * 于是复杂度是 O(表数 × 行数)，表一多就是平方级。
 * 而 `tomlValidate` 是在 Electron **主进程里同步**跑的（codex 的 preview/apply 各调 1~2 次），
 * 阻塞期间窗口与托盘全部无响应。
 *
 * 实测（审计脚本 audit-toml-perf / audit-e2e-freeze）：
 * ```
 *    表头数   文件      preview+apply 合计（主进程完全阻塞）
 *     500     27 KB          2.0 s
 *    1000     55 KB          8.9 s
 *    2000    110 KB         33.4 s
 *    4000    222 KB         ~133 s（推算）
 * ```
 * 真实用户的 config.toml 很少到 100 KB，但 `[projects."…"]` 那种表会随使用自然堆积 ——
 * 一旦堆到千级，点一次「写入 Codex」就是几十秒假死。
 *
 * 用 WeakMap 以数组**身份**为键：`tomlValidate` 内部从头到尾用的是同一个 lines 数组，
 * 一次调用只扫一遍；跨调用不缓存（避免文件改了还拿旧结果）。
 */
const tomlLexCache = new WeakMap();
function tomlLexMemo(lines) {
  let v = tomlLexCache.get(lines);
  if (!v) {
    v = tomlLex(lines);
    tomlLexCache.set(lines, v);
  }
  return v;
}

/**
 * 走一遍"代码行"（跳过处于多行字符串内部的行）。
 * 回调返回 `false` / `undefined` 表示继续找，返回**其它任何值**表示命中并返回该行下标。
 *
 * ⚠ 判定必须是"非 false/undefined"，不能写成 `=== true` —— 调用方返回的是**行号**，
 * 第 0 行命中时 `0` 既不是 `true` 也可能被误当成假值（实测踩到：写成 `=== true` 时
 * 第 1 行命中返回 `1`，既不等于 `true` 也不等于 `false`，于是"找不到键"、顶层键被重复插入）。
 *
 * @param fn (rawLine, index, codeLine) => any
 * @param from 起始行下标（默认 0）。**必须支持它**：调用方经常只需要扫一段，
 *   而每次都从 0 扫是 O(表数 × 行数) —— 见 tomlLexMemo 的说明。
 */
function forEachCodeLine(lines, limit, fn, from) {
  const { inMultiAt, codeOf } = tomlLexMemo(lines);
  const start = from === undefined || from === null ? 0 : Math.max(0, from);
  for (let i = start; i < limit; i++) {
    if (inMultiAt[i]) continue;
    const hit = fn(String(lines[i] == null ? '' : lines[i]), i, codeOf[i]);
    if (hit !== false && hit !== undefined) return i;
  }
  return -1;
}

/** 找表头 `[header]` 的行号范围（含表头行，到下一个表头或文件尾）。 */
function tomlSectionRange(lines, header) {
  // ⚠ 必须用**归一化**后的表标识比较，不能比原始串。
  // 旧实现比原始串，于是用户写成 `[model_providers . llmgateway]` 或
  // `["model_providers"."llmgateway"]` 时这里找不到，upsert 会再追加一张同名表 →
  // 整份 config.toml 变成非法，而自检与"写入成功"都发现不了。
  const want = tomlHeaderKey(String(header || '').replace(/^\[+|\]+$/g, '').trim());
  const heads = tomlScanHeaders(lines);
  const idx = heads.findIndex((h) => !h.isArray && (h.key || h.name) === want);
  if (idx < 0) return null;
  return {
    start: heads[idx].line,
    end: idx + 1 < heads.length ? heads[idx + 1].line : lines.length,
  };
}

/** 找顶层（第一个表头之前）某标量的行号；找不到返回 -1。 */
function tomlTopKeyLine(lines, key) {
  const heads = tomlScanHeaders(lines);
  const limit = heads.length ? heads[0].line : lines.length;
  const re = new RegExp('^\\s*' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=');
  // 用代码骨架匹配：字符串内容已被抹成空格，键不可能来自字符串内部
  return forEachCodeLine(lines, limit, (raw, i, code) => (re.test(code) ? i : false));
}

/** TOML 字符串值转义：基本字符串，双引号包裹。 */
function tomlString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
}

/**
 * 在 TOML 文本里 upsert 一个顶层标量（如 `model_provider = "lgw"`）。
 * 表头之前的同名键就地替换；不存在则插到文件最前（顶层键必须在任何表头之前）。
 */
function tomlUpsertTopKey(text, key, rawValue) {
  const src = String(text || '');
  const line = key + ' = ' + rawValue;
  // 空文件 / 全是空白：直接给出干净的一行。不做这步的话，"跳过开头空行"的游标会走到
  // 数组末尾，结果写出一个**以换行开头**的文件（实测踩到）。
  if (!src.trim()) return line + '\n';
  const lines = src.split(/\r?\n/);
  const idx = tomlTopKeyLine(lines, key);
  if (idx >= 0) lines[idx] = line;
  else {
    // 插到第一个表头之前（跳过开头的空行与注释块）
    let at = 0;
    while (at < lines.length && (/^\s*$/.test(lines[at]) || /^\s*#/.test(lines[at]))) at++;
    lines.splice(at, 0, line, '');
  }
  return keepEol(lines.join('\n'), src);
}

/**
 * 还原原文的行尾风格（LF / CRLF）。
 *
 * ⚠ 读入时用 `split(/\r?\n/)` 会丢掉 `\r`，写回时一律用 `\n` 拼 —— 于是**整份文件**的行尾
 * 被改写，而不只是被编辑的那几行。实测（2026-10-08 审计复现）：CRLF 的 config.toml
 * 原有 5 个 CR，写后剩 0 个。这类"内容没变、diff 全红"的改动最招人烦，
 * 而且因为它仍然是合法 TOML，`tomlValidate` 不会提示任何东西。
 *
 * 判据用"哪种行尾更多"而不是"有没有 CR"：混排文件按主要风格走，不会把少数派也翻过来。
 */
function keepEol(result, originalText) {
  const src = String(originalText || '');
  const crlf = (src.match(/\r\n/g) || []).length;
  if (crlf === 0) return result;
  const lfOnly = (src.match(/\n/g) || []).length - crlf;
  if (crlf < lfOnly) return result;          // 少数派是 CRLF → 保持 LF
  return String(result).replace(/\r?\n/g, '\r\n');
}

/**
 * 在 TOML 文本里 upsert 整张表（如 `[model_providers.llmgateway]`）。
 * 表已存在 → 整段替换；不存在 → 追加到文件末尾。
 *
 * @param {string} text
 * @param {string} header - 形如 'model_providers.llmgateway'（不含方括号）
 * @param {string[]} bodyLines - 表内各行（不带缩进要求，函数会原样写入）
 */
function tomlUpsertTable(text, header, bodyLines) {
  const lines = String(text || '').split(/\r?\n/);
  const block = ['[' + header + ']'].concat(bodyLines);
  const range = tomlSectionRange(lines, '[' + header + ']');
  if (range) {
    lines.splice(range.start, range.end - range.start, ...block);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(...block);
  }
  return keepEol(foldBlankLines(lines) + '\n', text);
}

/**
 * 只把**代码区**的连续空行折成一行；多行字符串内部的空行一律原样保留。
 *
 * ⚠ 旧实现是 `lines.join('\n').replace(/\n{3,}/g, '\n\n')` —— 对**整份文本**做全局替换，
 * 于是用户在 `"""` 里写的连续空行会被悄悄改掉：
 *     line1\n\n\n\nline5   →   line1\n\nline5
 * 文件仍然合法，所以任何闸门都不会察觉，但它违反了本文件自己写的铁律③
 *「只动自己那一小块」。实测（35-blank-lines-inside-multiline）确认。
 *
 * `tomlLex` 的 `inMultiAt[i]` 正好告诉我们第 i 行是不是处在多行字符串内部 ——
 * 用它区分"代码区空行"与"字符串内容空行"。
 */
function foldBlankLines(lines) {
  const { inMultiAt } = tomlLexMemo(lines);
  const out = [];
  let blankRun = 0;
  for (let i = 0; i < lines.length; i++) {
    const isBlank = String(lines[i] == null ? '' : lines[i]).trim() === '';
    if (isBlank && !inMultiAt[i]) {
      blankRun++;
      if (blankRun > 1) continue;        // 代码区连续空行最多留一行
    } else {
      blankRun = 0;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 把 TOML 表段解析成 {key: rawValueString}（只处理该段内的 `k = v` 行）。 */
function tomlReadTable(text, header) {
  const lines = String(text || '').split(/\r?\n/);
  const range = tomlSectionRange(lines, '[' + header + ']');
  const out = {};
  if (!range) return out;
  forEachCodeLine(lines, range.end, (raw, i) => {
    if (i <= range.start) return false;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (m) out[m[1]] = m[2];
    return false;
  });
  return out;
}

/** 去掉 TOML 值外层引号（用于展示）。 */
function tomlUnquote(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s;
}

/**
 * 统计一行带来的"括号净深度"增量（引号内与注释里的括号不算）。
 *
 * 只服务于下面 tomlValidate 的第 0 步：判断当前是否处在**跨行的数组/内联表**里。
 * 那些续行（`  "-y",`）本来就没有 `=`，不能按"键值对"去要求它们。
 * 刻意保守：认不出来时宁可少算，也不误伤合法文件。
 */
function bracketDelta(code) {
  let d = 0;
  let q = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#') break;
    if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}

/**
 * 这一行是否**结束在引号内部**（即字符串没闭合）。
 *
 * 先剥掉多行字符串的定界符 `"""` / `'''` —— 它们是"合法的未闭合"，不算错。
 * 剩下的按单引号扫描，末尾仍停在引号里就是漏了右引号。
 */
function endsInsideQuote(code) {
  const s = String(code == null ? '' : code).replace(/"""|'''/g, '');
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '#') return false;
    if (c === '"' || c === "'") q = c;
  }
  return q !== null;
}

/**
 * 轻量 TOML 自检：只查"会让解析器**整体**失败"的结构性问题。
 *
 * 为什么需要它（三条都是实测出来的高危）：我们改的是用户**已有的** config.toml，
 * 而 TOML 的坑比想象的深 —— 表头可以带行尾注释、可以出现在多行字符串里、还可以用
 * dotted-key 隐含声明。任何一处处理不到，写出去的文件就整体解析失败，
 * 用户自己的 provider / mcp_servers / projects 会**一起失效**，而我们还在报"写入成功"。
 *
 * 与其把所有形态都枚举对（做不到），不如：改完之后**自己验一遍**，不合格就拒绝写/回滚。
 * 这是"宁可不写，也不写坏"的兜底。
 *
 * @returns {string} 空串 = 通过；否则是给人看的错误说明
 */
function tomlValidate(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split(/\r?\n/);
  const lex = tomlLexMemo(lines);

  // 0) 行形状：代码行必须是"键 = 值"、表头或注释之一。
  //
  //    为什么必须有这一步（审计实测）：下面 1)~4) 全是对**结构**的检查，对
  //    `this line has no equals sign`、`[unclosed table`、`{ this is not json`
  //    这类**手工编辑失误**一律放行 —— 8 种真实坏写法 8 种全过。
  //    于是 codex 会带着"写入成功"把它们原样留着，而 Codex 自己的解析器读不了，
  //    用户拿不到任何提示（claude-code / opencode 在同类输入下都会拦）。
  //
  //    只判"确定不合法"的形态：没有 `=`、表头没有右括号。
  //    不做值层面的校验（`n = 12abc` 这种留给真正的解析器），避免误伤。
  {
    let depth = 0;
    let bad = '';
    // ⚠ 第二个参数是**循环上界**（`for (i = 0; i < limit; i++)`），不是起始行。
    // 传 0 的话一次都不跑 —— 这里必须传 lines.length。
    forEachCodeLine(lines, lines.length, (raw, i) => {
      const t = String(raw == null ? '' : raw).trim();
      if (depth === 0 && t && !t.startsWith('#')) {
        if (t.startsWith('[')) {
          if (!/\][ \t]*(#.*)?$/.test(t)) { bad = '第 ' + (i + 1) + ' 行的表头没有右括号'; return true; }
        } else if (!/^[^=]+=/.test(t)) {
          bad = '第 ' + (i + 1) + ' 行既不是「键 = 值」、也不是表头或注释';
          return true;
        } else if (endsInsideQuote(t)) {
          // 值里的引号没闭合（`model = "未闭合`）。TOML 会把它连到下一行甚至文件尾，
          // 是手工编辑最常见的事故之一，且会让整份文件不可读。
          bad = '第 ' + (i + 1) + ' 行的字符串没有闭合';
          return true;
        }
      }
      depth += bracketDelta(t);
      if (depth < 0) depth = 0;      // 多余的右括号不改变后续判定，别把后面全带偏
      return false;
    });
    if (bad) return 'TOML 语法有问题：' + bad;
    // ⚠ 括号必须回到 0。
    // 旧实现只在 `depth === 0` 时才做行形状检查，于是一个未闭合的 `[`
    //（最典型：`x = [1, 2` 手滑少写 `]`）会把 depth 永久顶在 >0，
    // **它之后所有行的检查全部被跳过** —— 校验函数就此失明。
    // 实测（2026-10-08 审计复现）：`x = [1, 2\nthis line has no equals sign\n` 一路放行，
    // preview.guard 一条理由都没有、apply.ok === true，而磁盘上的 config.toml 依然非法。
    //
    // 修法刻意只加这一条**平衡检查**，不把行形状检查解禁 —— 后者会误伤合法的多行数组
    //（`x = [\n  1,\n  2,\n]` 的中间几行本来就不长成"键 = 值"）。
    // 不平衡本身就是确定的语法错误，加这一条即可覆盖同一个洞。
    if (depth !== 0) return 'TOML 语法有问题：方括号/花括号没有闭合（多半是少写了一个 ] 或 }）';
  }

  // 1) 未闭合的多行字符串（用词法扫描的结果，而不是"数引号奇偶"——后者会把
  //    `a = """x'''y"""` 这种**合法**写法误判为未闭合）
  if (lex.endsInMulti) return 'TOML 里有未闭合的多行字符串（' + lex.endsInMulti + '）';

  const heads = lex.headers;

  // 2) 同一张表被声明两次
  {
    const seen = new Set();
    for (const h of heads) {
      if (h.isArray) continue;
      const k = h.key || h.name;
      if (seen.has(k)) return '表 [' + h.name + '] 被声明了两次（等价写法也算同一张表）';
      seen.add(k);
    }
  }

  // 3) 顶层 dotted-key 隐含创建的表，不能再被显式声明
  //    （例：`model_providers.llmgateway.name = "old"` 之后又写 `[model_providers.llmgateway]`
  //     → TOML 报 Cannot overwrite a value / Cannot declare … twice）
  {
    const firstHead = heads.length ? heads[0].line : lines.length;
    const implicit = new Set();
    forEachCodeLine(lines, firstHead, (raw) => {
      const m = /^\s*([A-Za-z0-9_.\-"']+)\s*=/.exec(raw);
      if (m && m[1].includes('.')) {
        const parts = m[1].split('.');
        for (let i = 1; i < parts.length; i++) implicit.add(tomlHeaderKey(parts.slice(0, i).join('.')));
      }
      return false;
    });
    for (const h of heads) {
      if (!h.isArray && implicit.has(h.key || h.name)) {
        return '表 [' + h.name + '] 已被顶层的 dotted key（' + h.name + '.xxx = …）隐含声明，不能再显式声明';
      }
    }
  }

  // 4) 同一张表内键重复（含**第一个表头之前的顶层区**）
  //
  //    ⚠ 顶层区原来被漏掉了：循环只从 heads[0] 开始，于是 `model = "a"` 紧跟
  //    `model = "b"` 这种顶层重复键一路放行 —— 而 TOML 对它是硬错误
  //    （Cannot overwrite a value），整份文件读不了。审计实测命中。
  {
    for (let hi = -1; hi < heads.length; hi++) {
      const h = hi < 0 ? { line: -1, name: '（顶层）' } : heads[hi];
      const end = hi + 1 < heads.length ? heads[hi + 1].line : lines.length;
      const seen = new Set();
      let dup = '';
      // ⚠ 第四个参数是**起始行**：这一段的扫描范围本来就只有 [h.line+1, end)，
      // 旧实现从 0 开始扫（靠回调里 `if (i <= h.line) return false` 跳过），
      // 于是每张表都要重走一遍前面的所有行 → O(表数 × 行数)。
      forEachCodeLine(lines, end, (raw) => {
        const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(raw);
        if (m) {
          if (seen.has(m[1])) dup = m[1];
          seen.add(m[1]);
        }
        return false;
      }, h.line + 1);
      if (dup) return (hi < 0 ? '顶层的键 ' : '表 [' + h.name + '] 里的键 ') + dup + ' 重复了';
    }
  }

  return '';
}

/* ---------------- 统一 Key 可用性判定 ---------------- */

/** 示例/模板里的占位 Key（公开值，任何人都能白用你的上游额度）。 */
const PLACEHOLDER_KEYS = new Set([
  'dsh-gateway-change-me',
  'dsh-gateway-xxxxxxxx',
  'sk-xxxxxxxx',
  'changeme',
  'placeholder',
]);

/**
 * 判断统一 Key 能不能用；能用返回空串，否则返回**给人看的**原因。
 *
 * 为什么要统一到一处：这套判定原先散在两个地方且**口径不一致** ——
 * `validateConfigText`（保存路径）拒绝占位 Key，而 6 个一键写入目标只查 `length < 16`。
 * 示例配置里的 `dsh-gateway-change-me` 恰好 22 字符，于是"保存被拦、写入放行"：
 * 全新安装时点一下「写入」就会把这个公开占位 Key 写进用户已有的客户端配置。
 */
function apiKeyProblem(key) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return '网关统一 Key 未设置 —— 请到「概览」页复制或重新生成';
  if (PLACEHOLDER_KEYS.has(k.toLowerCase())) {
    return '网关统一 Key 仍是示例占位值（' + k + '）：本机任何进程都能白用你的上游额度，请到「概览」页重新生成';
  }
  if (/^(sk|lgw|dsh-gateway)-?x{6,}$/i.test(k)) return '网关统一 Key 看起来是模板占位值，请换成真实随机 Key';
  if (k.length < 16) return '网关统一 Key 太短（' + k.length + ' 字符）—— 网关鉴权要求 ≥16 字符，否则所有请求都会 401';
  if (/[\r\n]/.test(k)) return '网关统一 Key 含换行 —— 写进配置文件会破坏文件格式';
  return '';
}

module.exports = {
  BACKUP_SUFFIX,
  BACKUP_SUFFIXES,
  PLACEHOLDER_KEYS,
  apiKeyProblem,
  exists, readText, readTarget, parseJsonObject, readJson,
  writeAtomic, restore, backupInfo, ensureDir,
  redact, maskValue, simpleDiff,
  tomlScanHeaders, tomlSectionRange, tomlTopKeyLine, tomlString, tomlUpsertTopKey, tomlUpsertTable, tomlReadTable, tomlUnquote,
  tomlHeaderKey,
  tomlValidate,
};
