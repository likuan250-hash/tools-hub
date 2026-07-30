// webview-preload.js —— 注入到主窗口内嵌的 kdocs/netdisk 页面，提供有限的原生能力。
// 仅暴露工具前端真正需要的接口（封面目录选择等），不开放 nodeIntegration。
const { contextBridge, ipcRenderer } = require("electron");

// 主题联动：工具箱是唯一的主题控制源。
// 内嵌项目页面不再持有任何独立主题逻辑，全部由这里注入 data-theme。
function applyTheme(t) {
  try {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("theme", t);
  } catch (e) {}
}
// 主题按钮直接隐藏，不依赖 sync-theme 到达时机，杜绝按钮在首屏闪现。
(function hideThemeBtn() {
  const tb = document.getElementById("themeBtn");
  if (tb) tb.style.display = "none";
})();
// 主动从主进程缓存的当前主题拉取初始主题，避免 webview 首屏主题闪动；
// 同时保留 sync-theme 监听，实时响应工具箱的主题切换。
ipcRenderer.on("sync-theme", (_e, t) => applyTheme(t));
try {
  ipcRenderer.invoke("get-theme").then((t) => { if (t) applyTheme(t); }).catch(() => {});
} catch (e) {}

contextBridge.exposeInMainWorld("electronAPI", {
  // 原生文件夹选择（kdocs 封面目录按钮调用）
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  // 系统默认浏览器打开外部链接（金山文档入口等）
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // 状态（预留）
  getStatus: () => ipcRenderer.invoke("get-status"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, p) => cb(p)),
});
