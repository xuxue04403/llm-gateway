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
      const def = DEFAULTS[k];
      if (def === undefined) continue;
      const v = patch[k];
      // 类型必须与默认值一致（null 也算不符——旧写法里 `v !== null` 这个例外会让
      // `{minimizeToTray: null}` 把布尔设置写成 null，之后 `!== false` 判断全部走样）。
      if (v === null || typeof v !== typeof def) continue;
      this.data[k] = v;
    }
    this.persist();
    return this.snapshot();
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.path);      // 原子写：半截 JSON 会让下次启动丢全部设置
    } catch (err) {
      this.log('settings.json 写入失败：' + (err && err.message ? err.message : err));
    }
  }

  snapshot() { return clone(this.data); }
}

module.exports = { Settings, DEFAULTS };
