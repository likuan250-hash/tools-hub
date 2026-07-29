// webview-preload.js —— 注入到主窗口内嵌的 kdocs/netdisk 页面，提供有限的原生能力。
// 仅暴露工具前端真正需要的接口（封面目录选择等），不开放 nodeIntegration。
const { contextBridge, ipcRenderer } = require("electron");

// 主题联动：工具箱切换主题后，把 data-theme 同步到内嵌项目页面（含 CSS 变量），
// 并隐藏内嵌项目自身的主题按钮，让工具箱成为唯一主题控制源。
function applyTheme(t) {
  try {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("theme", t);
  } catch (e) {}
  const tb = document.getElementById("themeBtn");
  if (tb) tb.style.display = "none";
}
ipcRenderer.on("sync-theme", (_e, t) => applyTheme(t));

contextBridge.exposeInMainWorld("electronAPI", {
  // 原生文件夹选择（kdocs 封面目录按钮调用）
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  // 状态（预留）
  getStatus: () => ipcRenderer.invoke("get-status"),
  onStatus: (cb) => ipcRenderer.on("status", (_e, p) => cb(p)),
});
