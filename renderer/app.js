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
  const sortBtn = document.getElementById("sortBtn");
  const sortHintEl = document.getElementById("sortHint");
  const updateBtn = document.getElementById("updateBtn");
  const updateStatusEl = document.getElementById("updateStatus");
  const winMin = document.getElementById("winMin");
  const winMax = document.getElementById("winMax");
  const winClose = document.getElementById("winClose");
  const quitModal = document.getElementById("quitModal");
  const quitCancel = document.getElementById("quitCancel");
  const quitConfirm = document.getElementById("quitConfirm");

  // ── 主题 ──
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("th-theme", t); } catch (e) {}
  }
  let theme = "dark";
  try { theme = localStorage.getItem("th-theme") || "dark"; } catch (e) {}
  applyTheme(theme);
  if (api && api.setTheme) { try { api.setTheme(theme); } catch (e) {} } // 上报主进程，供 webview 拉取
  themeBtn.onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    applyTheme(theme);
    if (api && api.setTheme) { try { api.setTheme(theme); } catch (e) {} }
    syncThemeToWebviews(theme); // 工具箱切换 → 内嵌项目同步切换
  };

  // 把当前工具箱主题同步到所有已打开的内嵌 webview（kdocs/netdisk）
  function syncThemeToWebviews(t) {
    openTabs.forEach((x) => {
      if (x.key === HOME_KEY) return;
      const wv = document.getElementById("wv-" + x.key);
      if (wv && wv.send) {
        try { wv.send("sync-theme", t); } catch (e) {}
      }
    });
  }

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
  let sortMode = false; // 卡片排序编辑模式

  // ── 卡片顺序持久化 ──
  // 读取已保存顺序：过滤已删除工具、把新增工具追加到末尾（兜底）
  function getCardOrder() {
    let stored = [];
    try {
      const raw = localStorage.getItem("card-order");
      if (raw) stored = JSON.parse(raw);
    } catch (e) {}
    if (!Array.isArray(stored)) stored = [];
    const valid = stored.filter((k) => TOOLS[k]);
    Object.keys(TOOLS).forEach((k) => { if (!valid.includes(k)) valid.push(k); });
    return valid;
  }
  // 把当前 DOM 顺序写回 localStorage
  function saveCardOrder() {
    const order = [...cardsEl.children].map((c) => c.dataset.key).filter(Boolean);
    try { localStorage.setItem("card-order", JSON.stringify(order)); } catch (e) {}
  }

  // ── 入口卡片 ──
  function renderCards(animate = true) {
    const order = getCardOrder();
    cardsEl.innerHTML = "";
    order.forEach((key, i) => {
      const t = TOOLS[key];
      if (!t) return;
      const s = serviceStatus[key] || {};
      const running = !!s.running;
      const card = document.createElement("div");
      card.className = "card" + (animate ? " pop-in" : "");
      card.dataset.key = key;
      if (animate) card.style.setProperty("--i", i); // 入场 stagger 序号
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", t.name + "，排序模式下可拖动调整顺序");
      card.innerHTML = `
        <div class="grip" aria-hidden="true">⠿</div>
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
        <button class="card-open" type="button">打开</button>
      `;
      // 液态玻璃高光跟随光标（写入 --mx/--my 供 ::before 径向高光使用）；排序/拖拽时不更新
      card.addEventListener("mousemove", (e) => {
        if (sortMode || card.classList.contains("dragging")) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
        card.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
      });
      card.querySelector(".card-open").onclick = () => openTab(t.key);
      card.addEventListener("pointerdown", (e) => onCardPointerDown(e, card));
      card.addEventListener("keydown", (e) => onCardKeyDown(e, card));
      cardsEl.appendChild(card);
    });
    cardsEl.classList.toggle("sorting", sortMode);
  }

  // 进入/退出排序编辑模式
  function toggleSortMode() {
    sortMode = !sortMode;
    if (sortBtn) {
      sortBtn.classList.toggle("active", sortMode);
      sortBtn.textContent = sortMode ? "✓" : "⇅";
      sortBtn.title = sortMode ? "完成排序" : "调整卡片顺序";
      sortBtn.setAttribute("aria-pressed", sortMode ? "true" : "false");
    }
    if (sortHintEl) sortHintEl.hidden = !sortMode;
    renderCards(false); // 重渲染以应用/撤除排序态样式（不打断 pop-in）
  }

  // 计算拖拽指针应落入的插入位置（网格阅读顺序：上排优先、同排左优先）
  function getInsertIndex(px, py, dragged) {
    const siblings = [...cardsEl.children].filter((c) => c !== dragged);
    let insert = siblings.length;
    for (let i = 0; i < siblings.length; i++) {
      const r = siblings[i].getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const cx = r.left + r.width / 2;
      if (py < cy - r.height / 2) { insert = i; break; }                       // 指针在更靠上的行
      if (Math.abs(py - cy) <= r.height / 2 && px < cx) { insert = i; break; } // 同排、中心左侧
    }
    return insert;
  }

  // 拖拽中：根据指针位置把被拖卡片插入新位置，并对兄弟卡片做 FLIP 平滑过渡
  function reorderTo(px, py, dragged) {
    const children = [...cardsEl.children];
    if (children.length < 2) return;
    const siblings = children.filter((c) => c !== dragged);
    // 先清掉兄弟卡片可能残留的 FLIP 过渡，保证测量准确
    siblings.forEach((c) => { c.style.transition = "none"; c.style.transform = ""; });
    void cardsEl.offsetWidth; // 强制回流
    const insert = getInsertIndex(px, py, dragged);
    const newOrder = [...siblings];
    newOrder.splice(insert, 0, dragged);
    const curKeys = children.map((c) => c.dataset.key).join(",");
    const newKeys = newOrder.map((c) => c.dataset.key).join(",");
    if (curKeys === newKeys) return;
    // FLIP：记录兄弟卡片当前位置 → 重排 DOM → 反位移后过渡归零
    const first = new Map();
    siblings.forEach((c) => first.set(c, c.getBoundingClientRect()));
    newOrder.forEach((c) => cardsEl.appendChild(c));
    siblings.forEach((c) => {
      const f = first.get(c);
      const last = c.getBoundingClientRect();
      const dx = f.left - last.left;
      const dy = f.top - last.top;
      if (dx || dy) {
        c.style.transition = "none";
        c.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          c.style.transition = "transform .3s var(--ease-spring)";
          c.style.transform = "";
        });
      }
    });
  }

  // 拖拽核心：Pointer Events 手写，鼠标/触屏通吃，不引库
  function onCardPointerDown(e, card) {
    if (!sortMode) return;          // 非排序模式不触发拖拽
    if (e.button !== 0) return;     // 仅左键
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    let curDx = 0, curDy = 0; // 当前已应用的跟随位移
    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
    cardsEl.classList.add("dragging-active");

    // 让被拖卡片始终贴着指针（按布局实时推算，DOM 重排后不跳变）
    function place(clientX, clientY) {
      const r = card.getBoundingClientRect();
      const layoutLeft = r.left - curDx;
      const layoutTop = r.top - curDy;
      curDx = (clientX - grabX) - layoutLeft;
      curDy = (clientY - grabY) - layoutTop;
      card.style.transform = `translate(${curDx}px, ${curDy}px) scale(1.04) rotate(1.5deg)`;
    }
    place(e.clientX, e.clientY);

    function move(ev) {
      place(ev.clientX, ev.clientY);
      reorderTo(ev.clientX, ev.clientY, card);
    }
    function up(ev) {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      card.releasePointerCapture(ev.pointerId);
      card.classList.remove("dragging");
      cardsEl.classList.remove("dragging-active");
      card.style.transform = "";
      card.style.transition = "";
      const key = card.dataset.key;
      saveCardOrder();
      renderCards(false); // 规范化 DOM（清除内联过渡）
      const restored = cardsEl.querySelector(`.card[data-key="${key}"]`);
      if (restored) restored.focus(); // 保住键盘焦点，可达性
    }
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
  }

  // 键盘可达性：排序模式下方向键移动卡片；普通模式 Enter/空格 打开
  function onCardKeyDown(e, card) {
    if (!sortMode) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTab(card.dataset.key); }
      return;
    }
    const order = [...cardsEl.children];
    const idx = order.indexOf(card);
    let target = -1;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") target = idx - 1;
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") target = idx + 1;
    else return;
    e.preventDefault();
    if (target < 0 || target >= order.length) return;
    const moved = order.slice();
    const [c] = moved.splice(idx, 1);
    moved.splice(target, 0, c);
    moved.forEach((el) => cardsEl.appendChild(el));
    saveCardOrder();
    card.focus();
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
    // DOM 准备好后触发一次 resize，确保 webview 内部内容正确撑满容器
    wv.addEventListener("dom-ready", () => {
      try { wv.send("sync-theme", theme); } catch (e) {} // 加载完成后同步工具箱主题
      if (wv.classList.contains("active")) {
        resizeWebview(wv);
        setTimeout(() => resizeWebview(wv), 60);
      }
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

  function resizeWebview(wv) {
    // webview 在显示/窗口大小变化后需要触发 resize 才能正确重绘内部尺寸
    if (!wv || !wv.resize) return;
    try { wv.resize(); } catch (e) {}
  }

  function switchTab(key) {
    activeKey = key;
    tabsEl.style.display = "flex";
    renderTabs();
    if (key === HOME_KEY) {
      // 入口页：显示 landing，隐藏所有工具 webview（不销毁，保留后台状态）
      landingEl.classList.remove("hidden");
      openTabs.forEach((x) => {
        if (x.key === HOME_KEY) return;
        const wv = document.getElementById("wv-" + x.key);
        if (wv) wv.classList.remove("active");
      });
      return;
    }
    // 工具页：隐藏 landing，显示对应 webview
    landingEl.classList.add("hidden");
    openTabs.forEach((x) => {
      if (x.key === HOME_KEY) return; // 跳过入口页，它不走 webview
      const wv = document.getElementById("wv-" + x.key);
      if (!wv) return;
      const active = x.key === key;
      const wasActive = wv.classList.contains("active");
      wv.classList.toggle("active", active);
      if (active) {
        // visibility 改变后内部布局需要一帧才能稳定，延迟 resize
        requestAnimationFrame(() => {
          resizeWebview(wv);
          // 再补一次，兼容某些情况下首帧未生效
          setTimeout(() => resizeWebview(wv), 60);
        });
      }
    });
  }

  // 窗口大小变化时，给当前活动 webview 触发 resize
  window.addEventListener("resize", () => {
    if (activeKey && activeKey !== HOME_KEY) {
      resizeWebview(document.getElementById("wv-" + activeKey));
    }
  });

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

  // ── 入口卡片排序开关 ──
  if (sortBtn) sortBtn.onclick = toggleSortMode;

  // ── 自定义标题栏窗口控制 ──
  if (api && api.windowControl) {
    winMin.onclick = () => api.windowControl("minimize");
    winMax.onclick = () => api.windowControl("maximize");
    winClose.onclick = () => api.windowControl("close");
    // 双击标题区（居中标题）最大化/还原
    const titleEl = document.querySelector(".top-center");
    if (titleEl) titleEl.addEventListener("dblclick", () => api.windowControl("maximize"));
  }

  // ── 退出确认弹窗（自定义玻璃拟态，替代系统原生对话框）──
  if (api && api.onRequestQuit) {
    api.onRequestQuit(() => {
      if (quitModal) quitModal.hidden = false;
    });
  }
  if (quitCancel) {
    quitCancel.onclick = () => { if (quitModal) quitModal.hidden = true; };
  }
  if (quitConfirm) {
    quitConfirm.onclick = () => {
      if (quitModal) quitModal.hidden = true;
      if (api && api.confirmQuit) api.confirmQuit();
    };
  }

  // 初始化：默认显示入口页标签
  switchTab(HOME_KEY);
})();
