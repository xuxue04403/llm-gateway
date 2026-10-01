// preload.js — 渲染进程安全桥（contextIsolation，无 nodeIntegration）
//
// 只暴露**具名动作**，不暴露 ipcRenderer 本身：渲染层拿不到任意通道，也就无法调用
// 未预期的 IPC。返回的取消函数供页面卸载时解绑。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lgw', {
  /* 状态与设置 */
  state: () => ipcRenderer.invoke('app:state'),
  // 带网关日志尾部的快照（日志页启动时用它填入"上一次会话"的日志）
  gwState: () => ipcRenderer.invoke('gw:state'),
  saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch),
  copyText: (text) => ipcRenderer.invoke('app:clipboard', text),
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),

  /* 网关 */
  gwAction: (name) => ipcRenderer.invoke('gw:action', name),
  gwSaveConfig: (text) => ipcRenderer.invoke('gw:save-config', text),
  gwValidate: (text) => ipcRenderer.invoke('gw:validate', text),
  gwHealth: () => ipcRenderer.invoke('gw:health'),
  gwTestProviders: (ids) => ipcRenderer.invoke('gw:test-providers', ids),
  gwFetchCatalog: (provider) => ipcRenderer.invoke('gw:fetch-catalog', provider),
  // 一键获取全部模型：连参数一起补全（上下文 / 图片 / 超时）+ 自动映射短名
  gwFetchModels: (provider, options) => ipcRenderer.invoke('gw:fetch-models', provider, options),
  // 实测建议超时（会对每个模型发一次最小请求；超时取决于本机网络，只能实测不能猜）
  gwMeasureModels: (provider, models) => ipcRenderer.invoke('gw:measure-models', provider, models),

  /* 一键写入 */
  writeDetect: () => ipcRenderer.invoke('write:detect'),
  writePreview: (id, options) => ipcRenderer.invoke('write:preview', id, options),
  writeApply: (id, options) => ipcRenderer.invoke('write:apply', id, options),
  writeRestore: (id) => ipcRenderer.invoke('write:restore', id),

  /* 配置导入导出 */
  cfgImport: () => ipcRenderer.invoke('cfg:import'),
  cfgImportFile: () => ipcRenderer.invoke('cfg:import-file'),
  cfgExport: (suggested) => ipcRenderer.invoke('cfg:export', suggested),
  cfgGenerateKey: () => ipcRenderer.invoke('cfg:generate-key'),

  /* 订阅 */
  onState: (cb) => {
    const l = (_e, snap) => cb(snap);
    ipcRenderer.on('gw:state', l);
    return () => ipcRenderer.removeListener('gw:state', l);
  },
  onLog: (cb) => {
    const l = (_e, text) => cb(text);
    ipcRenderer.on('gw:log', l);
    return () => ipcRenderer.removeListener('gw:log', l);
  },
});
