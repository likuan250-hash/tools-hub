// renderer/app.js —— 入口页逻辑（运行在 Electron 渲染进程）
(function () {
  "use strict";

  const api = window.electronAPI;
  const cardsEl = document.getElementById("cards");
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

  // ── 渲染卡片 ──
  const META = {
    kdocs: { name: "金山文档录入", port: 3599, desc: "游戏信息解析 → 金山文档多维表" },
    netdisk: { name: "网盘转存中转", port: 3000, desc: "分享链接转存 → 生成我的分享" },
  };

  function render(status) {
    cardsEl.innerHTML = "";
    let onlineCount = 0;
    const keys = Object.keys(META);
    keys.forEach((key) => {
      const info = status[key] || { running: false, url: "" };
      const meta = META[key];
      if (info.running) onlineCount++;
      const card = document.createElement("section");
      card.className = "card";
      card.innerHTML = `
        <div class="card-head">
          <span class="dot ${info.running ? "on" : "off"}"></span>
          <h2>${meta.name}</h2>
        </div>
        <p class="meta">端口 ${meta.port} · ${meta.desc}</p>
        <p class="state ${info.running ? "ok" : "bad"}">${info.running ? "● 运行中" : "○ 未运行"}</p>
        <button class="open-btn" data-key="${key}" ${info.running ? "" : "disabled"}>打开</button>
      `;
      cardsEl.appendChild(card);
    });
    aggEl.textContent = `服务状态：${onlineCount}/${keys.length} 在线`;
    // 绑定打开按钮
    cardsEl.querySelectorAll(".open-btn").forEach((btn) => {
      btn.onclick = () => {
        if (api && api.openTool) api.openTool(btn.getAttribute("data-key"));
      };
    });
  }

  // ── 初始化 ──
  if (api && api.getStatus) {
    api.getStatus().then(render).catch(() => render({}));
    if (api.onStatus) api.onStatus(render);
  } else {
    aggEl.textContent = "未运行在桌面应用环境中";
  }
})();
