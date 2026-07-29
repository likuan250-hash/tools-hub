// renderer/app.js —— 单窗口多标签壳体（运行在 Electron 渲染进程）
// 只有一个主窗口：顶部状态栏 + 标签栏 + 内容区（两个 <webview> 内嵌 kdocs/netdisk）。
// 切换标签只是显隐对应的 webview，不弹新窗口，且保留各工具页面状态。
(function () {
  "use strict";

  const api = window.electronAPI;
  const tabsEl = document.getElementById("tabs");
  const stageEl = document.getElementById("stage");
  const aggEl = document.getElementById("aggStatus");
  const themeBtn = document.getElementById("themeBtn");

  // ── 主题 ──
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("th-theme", t); } catch (e) {}
  }
  let theme = "dark";
  try { theme = localStorage.getItem("th-theme") || "dark"; } catch (e) {}
  applyTheme(theme);
  themeBtn.onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme(theme);
  };

  // ── 内嵌工具（webview）──
  const TOOLS = [
    { key: "kdocs", url: "http://localhost:3599" },
    { key: "netdisk", url: "http://localhost:3000" },
  ];

  async function buildWebviews() {
    // 非桌面环境（如直接用浏览器打开 index.html）没有 electronAPI，跳过内嵌
    if (!api || !api.getWebviewPreload) return;
    let preload;
    try {
      preload = await api.getWebviewPreload();
    } catch (e) {
      console.warn("无法获取 webview preload 路径", e);
      return;
    }
    TOOLS.forEach((t, i) => {
      const wv = document.createElement("webview");
      wv.setAttribute("src", t.url);
      wv.setAttribute("preload", preload);
      wv.setAttribute("allowpopups", "true"); // 授权类等弹窗需要（如百度 OAuth）
      wv.className = "wv";
      wv.style.display = i === 0 ? "block" : "none";
      wv.id = "wv-" + t.key;
      wv.addEventListener("did-fail-load", (e) => {
        // -3 = 用户主动取消/导航，可忽略
        if (e.errorCode === -3) return;
        console.warn("webview 加载失败", t.key, e.errorDescription);
      });
      stageEl.appendChild(wv);
    });
  }

  function switchTab(key) {
    tabsEl.querySelectorAll(".tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.key === key)
    );
    TOOLS.forEach((t) => {
      const wv = document.getElementById("wv-" + t.key);
      if (wv) wv.style.display = t.key === key ? "block" : "none";
    });
  }

  tabsEl.querySelectorAll(".tab").forEach((b) => {
    b.onclick = () => switchTab(b.dataset.key);
  });

  // ── 服务状态（顶部总状态）──
  function renderStatus(status) {
    const keys = Object.keys(status || {});
    const online = keys.filter((k) => status[k] && status[k].running).length;
    aggEl.textContent = `服务状态：${online}/${keys.length} 在线`;
  }
  if (api && api.getStatus) {
    api.getStatus().then(renderStatus).catch(() => renderStatus({}));
    if (api.onStatus) api.onStatus(renderStatus);
  } else {
    aggEl.textContent = "未运行在桌面应用环境中";
  }

  buildWebviews();
})();
