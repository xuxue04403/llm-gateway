// paths.js — 运行时路径解析（源码树直跑 / 打包后 asar 两种形态都能用）
'use strict';

const path = require('path');
const fs = require('fs');

// 应用根目录：src/ 的上一级
const APP_ROOT = path.resolve(__dirname, '..');

// 是否运行在 asar 内（打包后）。asar 内的文件只能读、不能写，因此运行时要解包到数据目录。
function inAsar(p) {
  const s = String(p || '');
  return s.includes('app.asar' + path.sep) || s.includes('app.asar/');
}

// 可执行文件所在目录（打包后 = 安装目录；源码直跑 = electron.exe 所在目录，
// 因此**不能**用它当"便携数据目录"的基准——见 datadir.js 的处理）。
//
// ⚠ 单文件便携版（electron-builder 的 `portable` target）有个坑：它会把程序**解包到临时目录**
// 再运行，于是 `process.execPath` 指向的是那个临时副本 —— 拿它当基准的话，用户数据会落在
// 临时目录里、每次运行都"重置"。真正的"exe 所在目录"由它注入的 PORTABLE_EXECUTABLE_DIR 给出。
function exeDir() {
  const portable = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim();
  if (portable) return portable;
  try { return path.dirname(process.execPath); } catch (_) { return APP_ROOT; }
}

// 应用资源目录（src/、renderer/、assets/ 的父目录）
const RESOURCES = APP_ROOT;

// 读取内置资源文本（打包后从 asar 读；调用方需要真实文件路径时用 materialize()）
function readResource(rel) {
  return fs.readFileSync(path.join(RESOURCES, rel), 'utf8');
}

function resourcePath(rel) {
  return path.join(RESOURCES, rel);
}

/**
 * 把 asar 内的资源解包到真实目录（外部 node 进程读不了 asar 内的文件）。
 * 返回解包后的真实路径；来源本来就是真实文件时原样返回。
 *
 * @param {string} rel - 相对应用根的路径，如 'src/gateway/model-gateway.mjs'
 * @param {string} destDir - 解包目标目录
 * @param {(msg:string)=>void} [log]
 */
function materialize(rel, destDir, log) {
  const src = resourcePath(rel);
  if (!inAsar(src)) return src;                 // 源码直跑：本来就是真实文件
  if (!fs.existsSync(src)) return src;
  const dest = path.join(destDir, path.basename(rel));
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);                 // 每次覆盖：asar 内即最新分发版本
    if (log) log('运行时已解包: ' + dest);
  } catch (err) {
    if (log) log('运行时解包失败 ' + (err && err.message ? err.message : err));
    return src;
  }
  return dest;
}

module.exports = { APP_ROOT, RESOURCES, exeDir, inAsar, readResource, resourcePath, materialize };
