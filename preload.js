// preload.js —— 安全的 IPC 桥（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 获取初始状态
  getStatus: () => ipcRenderer.invoke("get-status"),
  // 订阅状态推送（主进程在子进程运行/退出时主动推送）
  onStatus: (cb) => {
    ipcRenderer.on("status", (_event, payload) => cb(payload));
  },
  // 在工具窗口内打开对应服务
  openTool: (key) => ipcRenderer.invoke("open-tool", key),
  // 原生文件夹选择（替代 Tkinter IPC）
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
