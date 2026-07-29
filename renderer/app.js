// renderer/app.js —— 工具箱入口页 + 内嵌多标签
// 启动后显示入口页（工具卡片），点击卡片在顶部新增/切换标签，内嵌 <webview>。
(function () {
  "use strict";

  const api = window.electronAPI;
  const tabsEl = document.getElementById("tabs");
  const stageEl = document.getElementById("stage");
  const landingEl = document.getElementById("landing");
  const cardsEl = document.getElementById("toolCards");
  const aggEl = document.getElementById("aggStatus");
  const versionEl = document.getElementById("version");
  const themeBtn = document.getElementById("themeBtn");
  const updateBtn = document.getElementById("updateBtn");
  const updateStatusEl = document.getElementById("updateStatus");

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

  // ── 版本 ──
  if (api && api.getVersion) {
    api.getVersion().then((v) => { versionEl.textContent = "v" + v; }).catch(() => {});
  }

  // ── 工具注册表 ──
  const TOOLS = {
    kdocs: {
      key: "kdocs",
      name: "金山文档录入",
      desc: "粘贴游戏信息 → 自动解析 → AI 介绍 + 封面 + 多维表",
      url: "http://localhost:3599",
      icon: "📊",
    },
    netdisk: {
      key: "netdisk",
      name: "网盘转存中转",
      desc: "分享链接 → 转存我盘 → 生成我的分享（百度/夸克/迅雷）",
      url: "http://localhost:3000",
      icon: "☁️",
    },
  };

  let serviceStatus = {};
  let webviewPreload = "";
  const HOME_KEY = "__home__";
  const openTabs = [{ key: HOME_KEY, name: "入口" }]; // 入口页常驻、不可关闭
  let activeKey = HOME_KEY;

  // ── 入口卡片 ──
  function renderCards() {
    cardsEl.innerHTML = "";
    Object.values(TOOLS).forEach((t) => {
      const s = serviceStatus[t.key] || {};
      const running = !!s.running;
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-icon">${t.icon}</div>
        <div class="card-body">
          <div class="card-title">${t.name}</div>
          <div class="card-desc">${t.desc}</div>
          <div class="card-meta">
            <span class="dot ${running ? "ok" : "bad"}"></span>
            <span>${running ? "在线" : "离线"}</span>
            <span class="card-port">${t.url.replace("http://localhost:", "端口 ")}</span>
          </div>
        </div>
        <button class="card-open">打开</button>
      `;
      card.querySelector(".card-open").onclick = () => openTab(t.key);
      cardsEl.appendChild(card);
    });
  }

  // ── 标签与 webview ──
  async function ensurePreload() {
    if (webviewPreload) return webviewPreload;
    if (!api || !api.getWebviewPreload) return "";
    try {
      webviewPreload = await api.getWebviewPreload();
    } catch (e) {
      console.warn("无法获取 webview preload 路径", e);
    }
    return webviewPreload;
  }

  async function openTab(key) {
    const t = TOOLS[key];
    if (!t) return;
    if (openTabs.find((x) => x.key === key)) {
      switchTab(key);
      return;
    }

    openTabs.push({ key, name: t.name });

    // 创建 webview
    const preload = await ensurePreload();
    const wv = document.createElement("webview");
    wv.setAttribute("src", t.url);
    if (preload) wv.setAttribute("preload", preload);
    wv.setAttribute("allowpopups", "true"); // 授权页等弹窗需要
    wv.className = "wv";
    wv.id = "wv-" + key;
    wv.addEventListener("did-fail-load", (e) => {
      if (e.errorCode === -3) return;
      console.warn("webview 加载失败", key, e.errorDescription);
    });
    stageEl.appendChild(wv);

    renderTabs();
    switchTab(key);
  }

  function closeTab(key, event) {
    if (key === HOME_KEY) return; // 入口页不可关闭
    if (event) event.stopPropagation();
    const idx = openTabs.findIndex((x) => x.key === key);
    if (idx === -1) return;
    openTabs.splice(idx, 1);
    const wv = document.getElementById("wv-" + key);
    if (wv) wv.remove();
    renderTabs();
    if (activeKey === key) {
      const tools = openTabs.filter((x) => x.key !== HOME_KEY);
      switchTab(tools.length ? tools[tools.length - 1].key : HOME_KEY);
    }
  }

  function switchTab(key) {
    activeKey = key;
    tabsEl.style.display = "flex";
    renderTabs();
    if (key === HOME_KEY) {
      // 入口页：显示 landing，隐藏所有工具 webview（不销毁，保留后台状态）
      landingEl.style.display = "flex";
      openTabs.forEach((x) => {
        if (x.key === HOME_KEY) return;
        const wv = document.getElementById("wv-" + x.key);
        if (wv) wv.classList.remove("active");
      });
      return;
    }
    landingEl.style.display = "none";
    openTabs.forEach((x) => {
      if (x.key === HOME_KEY) return; // 跳过入口页，它不走 webview
      const wv = document.getElementById("wv-" + x.key);
      if (!wv) return;
      const active = x.key === key;
      wv.classList.toggle("active", active);
      // webview 从隐藏切到显示后需要触发一次 resize 才能正确重绘
      if (active && wv.resize) {
        try { wv.resize(); } catch (e) {}
      }
    });
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    if (!openTabs.length) return;
    openTabs.forEach((x) => {
      const isHome = x.key === HOME_KEY;
      const b = document.createElement("button");
      b.className = "tab" + (isHome ? " tab-home" : "") + (x.key === activeKey ? " active" : "");
      b.dataset.key = x.key;
      b.innerHTML = `<span>${x.name}</span>` + (isHome ? "" : `<span class="tab-close">×</span>`);
      b.onclick = () => switchTab(x.key);
      if (!isHome) {
        b.querySelector(".tab-close").onclick = (e) => closeTab(x.key, e);
      }
      tabsEl.appendChild(b);
    });
  }

  // ── 服务状态 ──
  function renderStatus(status) {
    serviceStatus = status || {};
    const keys = Object.keys(serviceStatus);
    const online = keys.filter((k) => serviceStatus[k] && serviceStatus[k].running).length;
    aggEl.textContent = `服务状态：${online}/${keys.length} 在线`;
    renderCards();
  }
  if (api && api.getStatus) {
    api.getStatus().then(renderStatus).catch(() => renderStatus({}));
    if (api.onStatus) api.onStatus(renderStatus);
  } else {
    aggEl.textContent = "未运行在桌面应用环境中";
    renderCards();
  }

  // ── 更新 ──
  function setUpdateUI(text, busy) {
    updateStatusEl.textContent = text || "";
    updateBtn.disabled = !!busy;
    updateBtn.textContent = busy ? "⏳ 检查中…" : "🔄 检测更新";
  }
  if (api && api.onUpdateStatus) {
    api.onUpdateStatus((p) => {
      switch (p.state) {
        case "checking":
          setUpdateUI("正在检查更新…", true);
          break;
        case "available":
          setUpdateUI(`发现新版本 ${p.version}，正在下载…`, true);
          break;
        case "progress":
          setUpdateUI(`下载中 ${Math.round(p.percent || 0)}%`, true);
          break;
        case "downloaded":
          setUpdateUI(`新版本 ${p.version} 已下载`, false);
          updateBtn.textContent = "🚀 立即安装";
          updateBtn.onclick = () => api.installUpdate && api.installUpdate();
          break;
        case "not-available":
          setUpdateUI("当前已是最新", false);
          break;
        case "error":
          setUpdateUI(`更新失败：${p.message || ""}`, false);
          break;
      }
    });
  }
  updateBtn.onclick = () => {
    if (api && api.checkUpdate) {
      api.checkUpdate().catch((e) => setUpdateUI("检查失败：" + (e.message || ""), false));
    }
  };

  // 初始化：默认显示入口页标签
  switchTab(HOME_KEY);
})();
