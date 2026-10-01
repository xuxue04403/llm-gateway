// logger.js — 应用日志（带轮转、时区精确、密钥打码）
//
// 为什么不用 console.log 了事：这套程序是"长期挂后台"的网关宿主，出问题时用户唯一能
// 依据的就是 data\logs\app.log。因此这里保证三件事：
//   ① 每行都带**本地时间 + 时区偏移**（跨时区/夏令时排查时不至于错判时间）；
//   ② 超过上限自动轮转，永不无限膨胀；
//   ③ 写日志前统一脱敏（sk-/nvapi-/Bearer 等），避免密钥随日志外泄。
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;      // 单文件上限 2MB
const KEEP_FILES = 3;                    // app.log.1 / .2 / .3

// 与网关引擎 maskSecretTokens 同款规则：常见密钥前缀 + 裸 Bearer。
// 只覆盖"有固定前缀"的形态；网关自己的统一 Key（`dsh-gateway-…`）没有可枚举的前缀，
// 靠下面的 registerSecret() 精确登记。
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}/gi,          // 加 i：上游 Key 的大小写不保证（SK-/Sk- 实测漏网）
  /\blgw-[A-Za-z0-9_-]{8,}/gi,          // 本程序生成的统一 Key 形态
  /\bdsh-gateway-[A-Za-z0-9_-]{8,}/gi,  // 从 dsh-app 继承来的统一 Key 形态
  /\bnvapi-[A-Za-z0-9_-]{8,}/gi,
  /\brc-[A-Za-z0-9_-]{12,}/gi,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,    // 细粒度 PAT（gh*_ 覆盖不到）
  /\bAKIA[0-9A-Z]{16}\b/g,              // AWS access key id
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,   // 裸 JWT
  // 阈值刻意保持 12（偏保守）。审计提过它"边界偏宽"——`Bearer token-abcdefghijkl`
  // 这类普通文本也会被抹掉。但方向比阈值更重要：日志里**过度**打码只是可读性损失，
  // **漏**打码是凭据泄漏。所以这里选容易误伤的那一侧。
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/**
 * 已登记的敏感串（运行时才知道的密钥，例如网关统一 Key）。
 *
 * 为什么需要它：正则只能匹配"看得出来的"密钥形态。这个程序自己在配置文件里生成
 * `dsh-gateway-<随机>` 形式的统一 Key，它不符合任何已知前缀 —— 一旦它出现在某条日志
 * （比如某个上游把收到的 Authorization 回显进错误体），正则一个字都拦不住。
 * 登记之后按**精确子串**替换，与形态无关。
 */
const REGISTERED_SECRETS = new Set();

function registerSecret(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.length >= 8) REGISTERED_SECRETS.add(s);   // 太短的串（如 "test"）全局替换会误伤日志
}

function maskSecrets(s) {
  let out = String(s == null ? '' : s);
  for (const secret of REGISTERED_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join('<masked:' + secret.length + '>');
  }
  for (const re of SECRET_RES) out = out.replace(re, (m) => m.slice(0, 6) + '…<masked>');
  return out;
}

/**
 * 正则替换。对**超大字符串**必须逐行处理 —— V8 在 `String.replace(re, fn)` 的
 * `GetSubstitution` 路径上有栈深限制：单个字符串到 ~5.6MB 时就会
 * `RangeError: Maximum call stack size exceeded`（实测 10MB × 20 次 **20/20 全抛**）。
 * 而"预览/写入"的输入就是**别的客户端配置文件的原文**，6MB 的 settings.json 并非天方夜谭
 * ——一抛就把该目标的预览与写入整个搞挂。
 * 逐行切分既避开栈限制，也不会漏（跨行的串本来就不是一个有效密钥）。
 */
const MASK_CHUNK_LIMIT = 1 << 20;

function applySecretRegex(out) {
  if (out.length <= MASK_CHUNK_LIMIT) {
    for (const re of SECRET_RES) {
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      out = out.replace(new RegExp(re.source, flags), '<masked>');
    }
    return out;
  }
  return out.split('\n').map((line) => {
    let l = line;
    for (const re of SECRET_RES) {
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      l = l.replace(new RegExp(re.source, flags), '<masked>');
    }
    return l;
  }).join('\n');
}

/**
 * **全量**打码：登记的密钥整串替换，形态类正则也整串抹掉（不留前 6 个字符）。
 *
 * 用在"写入预览"这类内容上 —— 那些 diff 用户会截图、贴到群里求助，留 6 个字符对排查
 * 没有帮助，却实实在在泄露了一截。日志走 maskSecrets（留前缀便于对照），
 * 预览走 maskSecretsFull。
 */
function maskSecretsFull(s) {
  let out = String(s == null ? '' : s);
  // 先做**精确登记串**的替换：用的是 split/join，不走正则，超大字符串也不会爆栈。
  for (const secret of REGISTERED_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join('<masked:' + secret.length + '>');
  }
  return applySecretRegex(out);
}

function tzOffsetMin(d) {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}

function stamp(d) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
    + ` (UTC${tzOffsetMin(d)})`;
}

class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    this.logPath = path.join(logDir, 'app.log');
    this._lastRotateCheck = 0;
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) { /* 目录建不了就退化成内存日志 */ }
  }

  _rotateIfNeeded() {
    const now = Date.now();
    if (now - this._lastRotateCheck < 10_000) return;      // 每 10 秒最多检查一次
    this._lastRotateCheck = now;
    let size = 0;
    try { size = fs.statSync(this.logPath).size; } catch (_) { return; }
    if (size < MAX_BYTES) return;
    try {
      for (let i = KEEP_FILES - 1; i >= 1; i--) {
        const from = `${this.logPath}.${i}`;
        const to = `${this.logPath}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.logPath, `${this.logPath}.1`);
      this._rotateFailed = false;
    } catch (e) {
      // ⚠ 轮转失败**必须说出来**。旧实现这里是个空 catch，于是任何持续性失败
      //（日志文件被杀软/索引器/网盘客户端锁住、ACL 异常、磁盘满）都会让轮转**永久静默停摆**：
      // 上限形同失效，app.log 无上限增长。只在第一次失败时记一条（避免刷屏），
      // 且直接写文件而不是走 write()（否则会递归）。
      if (!this._rotateFailed) {
        this._rotateFailed = true;
        try {
          fs.appendFileSync(this.logPath,
            `[${stamp(new Date())}] [WARN] 日志轮转失败（${e && e.message ? e.message : e}）：`
            + 'app.log 可能持续增长，请检查该文件是否被其它程序占用。\n');
        } catch (_) { /* 连这条都写不进去就只能放弃了 */ }
      }
    }
  }

  write(level, msg) {
    // 把消息里的换行压成可见的转义形式：否则一条含 \n 的消息（渲染层的 console 文本、
    // 上游错误体回显）能在日志里**伪造出完整的日志行**，包括伪造时间戳与级别。
    const oneLine = String(msg == null ? '' : msg).replace(/\r\n|\r|\n/g, '\\n');
    const line = `[${stamp(new Date())}] [${level}] ${maskSecrets(oneLine)}\n`;
    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.logPath, line);
    } catch (_) { /* 磁盘满/权限问题：不抛，界面仍能通过内存日志看到 */ }
    // 开发期同步到 stderr，方便 electron . 直跑时观察
    if (!process.env.LLM_GATEWAY_QUIET) {
      try { process.stdout.write(line); } catch (_) { /* 忽略 */ }
    }
  }

  info(msg) { this.write('INFO', msg); }
  warn(msg) { this.write('WARN', msg); }
  error(msg) { this.write('ERROR', msg); }

  // 供 UI 预览：读日志尾部
  tail(maxBytes) {
    const n = maxBytes || 64 * 1024;
    try {
      const size = fs.statSync(this.logPath).size;
      const start = Math.max(0, size - n);
      const fd = fs.openSync(this.logPath, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { return ''; }
  }

  clear() {
    try { fs.writeFileSync(this.logPath, ''); } catch (_) { /* 忽略 */ }
  }
}

/**
 * 深扫任意结构，把所有字符串过一遍 maskSecretsFull。
 * 用于"要把一份完整载荷送到渲染层"的场合（如写入预览）——预览里带着别的客户端配置文件的
 * 原文，里面的密钥不能因为"只是为了显示 diff"就送出去。
 */
function scrubDeepSecrets(v, depth) {
  const d = depth || 0;
  if (d > 12) return '<deep>';
  if (typeof v === 'string') return maskSecretsFull(v);
  if (Array.isArray(v)) return v.map((x) => scrubDeepSecrets(x, d + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = scrubDeepSecrets(v[k], d + 1);
    return out;
  }
  return v;
}

module.exports = { Logger, maskSecrets, maskSecretsFull, scrubDeepSecrets, registerSecret, stamp };
