// settings.js — 应用自身设置（与网关配置 gateway.config.json 分开存）
//
// 分离的理由：gateway.config.json 是**网关引擎的输入**（含全部上游密钥，会被 --write-dsh
// 读取、也可能被用户手工编辑/导入导出）；settings.json 是本程序窗口/托盘/自启这些**宿主
// 偏好**。混在一起会让"导出网关配置分享给别人"变成"连我的窗口位置一起泄露"。
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  version: 1,
  // 网关
  autoStartGateway: true,        // 应用启动时自动拉起网关
  // 窗口
  minimizeToTray: true,          // 点关闭按钮 → 最小化到托盘（不是退出）
  openDevTools: false,
  // 启动
  autoStartApp: false,           // 开机自启
  // 一键写入
  lastTarget: '',                // 上次写入的目标（UI 高亮）
  // 日志
  gatewayLogLines: 400,
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// 绝不能从配置文件写进内存的键（原型污染三件套）。
// 说明：靠 `DEFAULTS[k] === undefined` 这个判断其实也能挡住 `__proto__`（因为
// `DEFAULTS['__proto__']` 取到的是继承来的 Object.prototype，不是 undefined）——
// 但那是**巧合**，不是设计。显式列出来，别把安全性建立在语言细节上。
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class Settings {
  constructor(dataDir, log) {
    this.path = path.join(dataDir, 'settings.json');
    this.log = log || (() => {});
    this.data = clone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          // 认识的键：逐个覆盖。
          for (const k of Object.keys(DEFAULTS)) {
            if (raw[k] !== undefined) this.data[k] = raw[k];
          }
          // 不认识的键：**保留在内存里也保留在磁盘上** —— 用户手写的内容不替人做主，
          // 而且 save() 是整体重写文件，丢掉它们等于悄悄删用户的东西。
          // （save() 只接受白名单键：渲染层传进来的未知键不会被写进去。）
          for (const k of Object.keys(raw)) {
            if (UNSAFE_KEYS.has(k)) continue;
            if (DEFAULTS[k] === undefined) this.data[k] = raw[k];
          }
        }
      }
    } catch (err) {
      // 配置坏了不能让程序起不来：留证据 + 用默认值继续
      this.log('settings.json 解析失败，已改用默认设置：' + (err && err.message ? err.message : err));
      try { fs.copyFileSync(this.path, this.path + '.bak-broken'); } catch (_) { /* 忽略 */ }
    }
  }

  get(key) { return this.data[key]; }

  save(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return this.snapshot();
    for (const k of Object.keys(patch)) {
      // 只接受**已知键**。load() 会保留文件里用户手写的未知键（不替人做主），但 save() 的
      // 入参来自渲染层，放行未知键等于给它一个往设置文件里塞任意内容的入口。
      // ⚠ 用 `hasOwnProperty` 而不是 `DEFAULTS[k] === undefined`：后者在 patch 自带
      // `__proto__` 时不成立（`DEFAULTS['__proto__']` 取到的是继承来的 Object.prototype，
      // 不是 undefined），于是那一条能通过白名单并把 `this.data.__proto__` 换掉
      // （渲染/宿主审计 Q2 实测 `get('pwned') === 'yes'`）。目前没有可利用后果
      // （调用点全用字面量键、落盘走 JSON 只序列化自有属性），但判据本身是错的。
      // UNSAFE_KEYS 见文件头 —— 显式列出来，别把安全性建立在语言细节上。
      if (UNSAFE_KEYS.has(k)) continue;
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue;
      const def = DEFAULTS[k];
      const v = patch[k];
      // 类型必须与默认值一致（null 也算不符——旧写法里 `v !== null` 这个例外会让
      // `{minimizeToTray: null}` 把布尔设置写成 null，之后 `!== false` 判断全部走样）。
      if (v === null || typeof v !== typeof def) continue;
      this.data[k] = v;
    }
    return { settings: this.snapshot(), ...this.persist() };
  }

  /**
   * 落盘。
   *
   * ⚠ 必须把成败**返回**去。旧实现 `catch { this.log(...) }` 之后静默继续，
   *   而 `save()` 无条件返回快照、`main.js` 又无条件回 `{ ok: true }` ——
   *   于是写盘失败（文件只读、磁盘满、路径被占成同名目录）时，
   *   界面照样播「已保存应用设置」，勾选框也是勾上的，**重启就变回去**，
   *   用户完全找不到原因。渲染层其实**已经写好了**失败分支（`renderer/js/settings.js:103`
   *   的注释原话："必须看返回值…四项开关全部假成功"，并做了回滚 + 报错 toast），
   *   但因为主进程从不回 `ok:false`，那个分支是**永远触发不了**的死代码。
   *   实测（渲染/宿主审计 D5）：把 settings.json 换成同名目录 → 磁盘无文件、日志有 EPERM、
   *   界面播「已保存」。这里把这条链路接上。
   *
   * @returns {{ok:boolean, error?:string}}
   */
  persist() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.path);      // 原子写：半截 JSON 会让下次启动丢全部设置
      return { ok: true };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      this.log('settings.json 写入失败：' + msg);
      // 清掉半截 tmp，别在数据目录里留垃圾（实测失败后会残留 settings.json.tmp-<pid>）
      try { fs.unlinkSync(this.path + '.tmp-' + process.pid); } catch (_) { /* 忽略 */ }
      return { ok: false, error: msg };
    }
  }

  snapshot() { return clone(this.data); }

  /**
   * 把内存里的设置换回给定快照（**不落盘**）。
   *
   * 用途：落盘失败时回滚。`save()` 是"先改内存、再 persist"，所以 persist 失败那一刻
   * 内存里已经是新值、磁盘上还是旧值 —— 两者分叉会让"这次会话里开关看着生效、
   * 重启就变回去"，正是这次要修的那个现象。回滚内存，两边就一致了。
   */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
    this.data = clone(snapshot);
  }
}

module.exports = { Settings, DEFAULTS };
