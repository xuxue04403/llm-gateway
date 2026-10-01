// winutil.js — Windows 平台工具
//
// 现在只剩 PATH 处理这一件事 —— 原先随 dsh-app 一起带过来的 `resolveCmdExe` /
// `comSpecIsStale`（为"隐藏控制台宿主"解析 cmd.exe）在本程序里**从未被调用过**：
// 本程序不通过 cmd/broker 启动任何东西，网关引擎由 `spawn(exe, args)` 直接拉起。
// 死代码会被审计当成"没人验证过的路径"，所以删掉。
'use strict';

const path = require('path');

/**
 * 找出 env 对象里 PATH 的**实际键名**（大小写不敏感）。
 *
 * 为什么需要它（从 dsh-app 继承来的实测事故）：Windows 上这个变量的名字通常是
 * **`Path`（混合大小写）**，而 `Object.assign({}, process.env, …)` 产出的是**普通对象**
 * ——键名大小写敏感。于是 `env.PATH = …` 不是"更新原值"，而是**新建了一个 `PATH` 键**：
 * 原 `Path` 仍在对象里，但 Node 序列化环境块时按大小写不敏感去重、后设的 `PATH` 胜出
 * → **完整 PATH 被整个丢掉**。实测后果：应用被资源管理器（PATH 19 项）启动，交给子进程的
 * 只剩 2 个目录，于是子进程里 `icacls`/`robocopy`/`cmd` 全部按名字调不到。
 *
 * @param {object} env 环境对象
 * @returns {string} 现有键名；不存在时返回 'PATH'
 */
function pathKeyOf(env) {
  for (const k of Object.keys(env || {})) {
    if (k.toLowerCase() === 'path') return k;
  }
  return 'PATH';
}

/**
 * 把若干目录**前置**到 env 的 PATH（就地更新既有键，绝不新建大小写不同的重复键）。
 *
 * @param {object} env 环境对象（就地修改）
 * @param {string[]} dirs 要前置的目录（空值自动跳过）
 * @returns {string} 实际使用的键名
 */
function prependPath(env, dirs) {
  const target = env || {};
  const key = pathKeyOf(target);
  const cur = typeof target[key] === 'string' ? target[key] : '';
  const head = (dirs || []).filter((d) => d && String(d).trim()).map(String);
  const parts = head.concat(cur ? [cur] : []);
  target[key] = parts.join(path.delimiter);
  return key;
}

module.exports = { pathKeyOf, prependPath };
