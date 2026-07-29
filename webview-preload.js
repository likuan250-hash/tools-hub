// webview-preload.js —— 注入到主窗口内嵌的 kdocs/netdisk 页面，提供有限的原生能力。
// 仅暴露工具前端真正需要的接口（封面目录选择等），不开放 nodeIntegration。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 原生文件夹选择（kdocs 封面目录按钮调用）
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  // 状态（预留）
  getStatus: () => ipcRenderer.invoke("get-status"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, p) => cb(p)),
});
