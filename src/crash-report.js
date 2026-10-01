// crash-report.js — 网关反复异常退出时固化现场
//
// 为什么需要：网关"每 3 分钟自杀一次、每次都自愈重启"这种周期性故障，光看 app.log 会被
// 大量正常日志淹没，而且滚动日志会把最早（最有价值）的那次现场冲掉。这里把**退出码 +
// 自愈次数 + 当时配置摘要（密钥全部脱敏）+ 日志尾部**落成一份独立 JSON，供事后排查。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { maskSecrets } = require('./logger');   // 复用同一套脱敏（含运行时登记的精确密钥）

const MAX_REPORTS = 10;

/** 把 URL 里的 userinfo（代理认证的 user:password）抠出来打码，其余部分原样。 */
function maskUrlUserinfo(s) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i.exec(s);
  if (!m) return s;
  return m[1] + '<masked-userinfo>@' + s.slice(m[0].length);
}

function maskDeep(v, depth) {
  if (depth > 6) return '<deep>';
  if (v == null) return v;
  if (typeof v === 'string') {
    // 1) URL 里的凭据必须先抠掉 —— 它长得像 URL，会被后面的"像密钥"豁免规则放过。
    //    实测：`http://user:SuperSecret@proxy:8080` 会被整体放行。
    const noCred = maskUrlUserinfo(v);
    // 2) 再走统一脱敏（含运行时登记的精确密钥）。
    const masked = maskSecrets(noCred);
    if (masked !== noCred) return masked;
    if (noCred !== v) return noCred;
    // 3) 最后才是"像密钥"的长度启发式 —— 它只是兜底，误伤多（模型名、主机名都会被它吃掉），
    //    所以放在最后，且只对"无空格无斜杠且不是 URL"的长串生效。
    if (v.length >= 16 && !/^https?:\/\//i.test(v) && !/[\\/\s]/.test(v)) return '<masked:' + v.length + '>';
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => maskDeep(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 80)) {
      if (/key|token|secret|password|authorization|credential/i.test(k)) out[k] = '<masked>';
      else out[k] = maskDeep(v[k], depth + 1);
    }
    return out;
  }
  return String(v);
}

class CrashReport {
  constructor(dataDir, log) {
    this.dir = path.join(dataDir, 'crash');
    this.log = log || (() => {});
  }

  /**
   * 记录一次现场。
   * @param {string} kind - 'gateway' 之类
   * @param {Error|null} err
   * @param {object} info - { phase, context, config?, logTail? }
   * @returns {string|null} 落盘路径
   */
  record(kind, err, info) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const info2 = info || {};
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(this.dir, `${kind}-${stamp}.json`);
      const payload = {
        at: new Date().toISOString(),
        kind,
        phase: info2.phase || '',
        error: err ? { message: err.message, stack: String(err.stack || '').slice(0, 4000) } : null,
        context: maskDeep(info2.context || {}, 0),
        platform: { os: os.release(), arch: process.arch, node: process.versions.node, electron: process.versions.electron || '' },
        config: info2.config ? maskDeep(info2.config, 0) : undefined,
        // ⚠ logTail 是**原始日志文本**，必须过同一套脱敏。
        // 实测：直接 slice 会把上游回显的 Authorization、登记的网关统一 Key、
        // base64 形态的上游 Key 原样写进这个"要求用户外发分享"的文件里。
        logTail: typeof info2.logTail === 'string' ? maskSecrets(info2.logTail.slice(-8000)) : undefined,
      };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      this.prune();
      this.log('崩溃现场已保存：' + file);
      return file;
    } catch (e) {
      this.log('崩溃现场保存失败：' + (e && e.message ? e.message : e));
      return null;
    }
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const x of files.slice(MAX_REPORTS)) {
        try { fs.unlinkSync(path.join(this.dir, x.f)); } catch (_) { /* 忽略 */ }
      }
    } catch (_) { /* 忽略 */ }
  }

  list() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const p = path.join(this.dir, f);
          const st = fs.statSync(p);
          return { name: f, path: p, size: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    } catch (_) { return []; }
  }
}

module.exports = { CrashReport, maskDeep, maskUrlUserinfo };
