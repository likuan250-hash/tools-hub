// preload.js —— 安全的 IPC 桥（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // 应用版本
  getVersion: () => ipcRenderer.invoke("get-version"),
  // 获取初始状态
  getStatus: () => ipcRenderer.invoke("get-status"),
  // 订阅状态推送（主进程在子进程运行/退出时主动推送）
  onStatus: (cb) => {
    ipcRenderer.on("status", (_event, payload) => cb(payload));
  },
  // 获取 webview 的 preload 绝对路径（渲染进程用来创建内嵌 webview）
  getWebviewPreload: () => ipcRenderer.invoke("get-webview-preload"),
  // 原生文件夹选择（替代 Tkinter IPC）
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  // 更新相关
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateStatus: (cb) => {
    ipcRenderer.on("update-status", (_event, payload) => cb(payload));
  },
  // 自定义标题栏的窗口控制（最小化/最大化/关闭）
  windowControl: (action) => ipcRenderer.invoke("window-control", action),
  // 主题单一真源：渲染进程把当前主题上报给主进程，供 webview-preload 拉取
  setTheme: (t) => ipcRenderer.invoke("set-theme", t),
  // 退出确认弹窗：主进程请求显示自定义确认框 / 用户确认后真正关闭
  onRequestQuit: (cb) => {
    ipcRenderer.on("request-quit-confirm", () => cb());
  },
  confirmQuit: () => ipcRenderer.invoke("confirm-quit"),
});
