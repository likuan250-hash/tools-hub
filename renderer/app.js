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
  const themeBtn = document.getElementById("themeBtn");
  const sortBtn = document.getElementById("sortBtn");
  const sortHintEl = document.getElementById("sortHint");
  const updateBtn = document.getElementById("updateBtn");
  let currentVersion = "";
  if (api && api.getVersion) {
    api.getVersion()
      .then((v) => { currentVersion = v; updateBtn.textContent = "v" + v; })
      .catch(() => { updateBtn.textContent = "v?"; });
  }
  const updateStatusEl = document.getElementById("updateStatus");
  const winMin = document.getElementById("winMin");
  const winMax = document.getElementById("winMax");
  const winClose = document.getElementById("winClose");
  const quitModal = document.getElementById("quitModal");
  const quitCancel = document.getElementById("quitCancel");

  // 拖拽几何计算（DOM 无关的纯函数）。
  // ⚠️ 渲染进程 webPreferences: nodeIntegration=false + contextIsolation=true（main.js:298-299），
  // 因此 `require` 在渲染进程里是 undefined —— 原代码在此行直接抛 ReferenceError，
  // 导致整个 IIFE 在第 24 行就崩溃，其后所有事件绑定 / renderStatus / renderCards 全部不执行，
  // 这正是「卡在初始化中…、卡片空白、整页无法操作」的根因。
  // 改为从 window 读取（drag-geometry.js 已以 <script> 注入），并保留一份内联兜底实现，
  // 保证即使该文件缺失也能渲染卡片、拖拽仍可工作，绝不再依赖 require。
  const computeInsertIndex =
    (typeof window !== "undefined" && typeof window.computeInsertIndex === "function")
      ? window.computeInsertIndex
      : function fallbackComputeInsertIndex(rects, px, py) {
          let idx = rects.length;
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            const cy = r.top + r.height / 2;
            const cx = r.left + r.width / 2;
            if (py < cy - r.height / 2) { idx = i; break; }
            if (Math.abs(py - cy) <= r.height / 2 && px < cx) { idx = i; break; }
          }
          return idx;
        };
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

  // ── 工具注册表 ──
  const TOOLS = {
    kdocs: {
      key: "kdocs",
      name: "金山文档录入",
      desc: "粘贴游戏信息 → 自动解析 → Steam 官方介绍/封面 + 多维表",
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
  biliup: {
    key: "biliup",
    name: "B站自动投稿",
    desc: "选视频 → 填标签 → 选模式 → 一键投稿（上传/抽帧/合集/置顶）",
    url: "http://localhost:3600",
    icon: "📺",
  },
  material: {
    key: "material",
    name: "素材搜集",
    desc: "输入游戏名 → 自动建号文件夹 → 官方封面 + 宣传片落盘素材库",
    url: "http://localhost:3700",
    icon: "🎮",
  },
};

  let serviceStatus = {};
  let webviewPreload = "";
  const HOME_KEY = "__home__";
  const openTabs = [{ key: HOME_KEY, name: "入口" }]; // 入口页常驻、不可关闭
  let activeKey = HOME_KEY;
  let sortMode = false; // 卡片排序编辑模式

  // 待激活兜底定时器：key -> timerId（服务未起导致 dom-ready 不触发时强制激活）
  const pendingFallbacks = new Map();

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
            ${(typeof statusHTML === "function")
              ? statusHTML(running ? "ok" : "off", running ? "在线" : "离线")
              : (running ? "在线" : "离线")}
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
      sortBtn.textContent = sortMode ? "✓ 完成" : "⇅ 调整顺序";
      sortBtn.title = sortMode ? "完成排序" : "调整卡片顺序";
      sortBtn.setAttribute("aria-pressed", sortMode ? "true" : "false");
    }
    if (sortHintEl) sortHintEl.hidden = !sortMode;
    renderCards(false); // 重渲染以应用/撤除排序态样式（不打断 pop-in）
  }

  // 拖拽核心：Pointer Events 手写，鼠标/触屏通吃，不引库。
  // 性能优化要点（解决卡顿）：
  //   1) pointermove 用 rAF 合帧，最多每帧执行一次（而非每次事件都跑，事件频率可达 ~120Hz）；
  //   2) 兄弟卡片矩形在拖拽过程中「稳定」——仅在重排时变动，因此缓存起来，
  //      插入位置判定纯算术、零 getBoundingClientRect，消除 layout thrashing；
  //   3) reorder 自身完成「读→写→读」分批，去掉了原先每帧强制的 void offsetWidth 回流；
  //   4) 仅在插入位置真正变化时才重排 + FLIP，平时 pointermove 几乎零成本；
  //   5) CSS 侧 .dragging-active 给卡片加 will-change:transform 并临时去掉 backdrop-filter，
  //      避免每帧重绘昂贵的毛玻璃（见 style.css）。
  function onCardPointerDown(e, card) {
    if (!sortMode) return;          // 非排序模式不触发拖拽
    if (e.button !== 0) return;     // 仅左键
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const grabX = e.clientX - rect.left;
    const grabY = e.clientY - rect.top;
    let layoutLeft = rect.left;     // 被拖卡片布局基准（不含 transform），仅重排时刷新
    let layoutTop = rect.top;
    // 缓存兄弟卡片矩形：拖拽中兄弟仅在重排时变动，平时稳定 → 判定插入位无需每帧测量
    let siblingRects = [...cardsEl.children]
      .filter((c) => c !== card)
      .map((c) => c.getBoundingClientRect());
    let insertIndex = siblingRects.length; // 当前插入位置（相对 siblings）
    let rafScheduled = false;
    let rafId = 0;
    let flipRaf = 0;
    let lastX = e.clientX, lastY = e.clientY;

    card.setPointerCapture(e.pointerId);
    card.classList.add("dragging");
    cardsEl.classList.add("dragging-active");

    // 被拖卡片始终贴着指针：相对其布局基准推算位移，避免每帧读取自身 rect
    function applyFollow(x, y) {
      const dx = (x - grabX) - layoutLeft;
      const dy = (y - grabY) - layoutTop;
      card.style.transform = `translate(${dx}px, ${dy}px) scale(1.04) rotate(1.5deg)`;
    }

    // 用缓存矩形计算插入位置（纯算术，零布局读取）
    // 几何计算抽到 drag-geometry.js（DOM 无关），此处仅作薄封装。
    const computeInsert = (px, py) => computeInsertIndex(siblingRects, px, py);

    // 插入位置变化时重排 + FLIP；自身完成读→写→读分批，杜绝 layout thrashing
    function doReorder(idx) {
      const siblings = [...cardsEl.children].filter((c) => c !== card);
      const newOrder = [...siblings];
      newOrder.splice(idx, 0, card);
      const curKeys = [...cardsEl.children].map((c) => c.dataset.key).join(",");
      const newKeys = newOrder.map((c) => c.dataset.key).join(",");
      if (curKeys === newKeys) return;
      if (flipRaf) cancelAnimationFrame(flipRaf);
      // 落定兄弟卡片可能残留的 FLIP 过渡/位移，保证 first 测量是真实 layout
      siblings.forEach((c) => { c.style.transition = "none"; c.style.transform = ""; });
      // 读阶段：neutralize 被拖卡片后，测得所有卡片当前 layout（first）
      card.style.transform = "";
      const first = new Map();
      [...cardsEl.children].forEach((c) => first.set(c, c.getBoundingClientRect()));
      // 写阶段：重排 DOM
      newOrder.forEach((c) => cardsEl.appendChild(c));
      // 读阶段：测得重排后 layout（last，含被拖卡片新槽位）
      const last = new Map();
      newOrder.forEach((c) => last.set(c, c.getBoundingClientRect()));
      // FLIP 兄弟卡片（被拖卡片单独处理，不参加过渡动画）
      newOrder.forEach((c) => {
        if (c === card) return;
        const f = first.get(c), l = last.get(c);
        const dx = f.left - l.left, dy = f.top - l.top;
        c.style.transition = "none";
        c.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      // 被拖卡片：把布局基准更新为新槽位，稍后由 applyFollow 重新贴合指针
      const cl = last.get(card);
      if (cl) { layoutLeft = cl.left; layoutTop = cl.top; }
      flipRaf = requestAnimationFrame(() => {
        newOrder.forEach((c) => {
          if (c === card) return;
          c.style.transition = "transform .3s var(--ease-spring)";
          c.style.transform = "";
        });
      });
      // 兄弟矩形已随重排改变，用上一步测得的 layout（last）刷新缓存，
      // 避免被刚写入的反向位移 transform 污染（getBoundingClientRect 含 transform）
      siblingRects = newOrder.filter((c) => c !== card).map((c) => last.get(c));
      applyFollow(lastX, lastY);
    }

    function frame() {
      rafScheduled = false;
      applyFollow(lastX, lastY);
      const idx = computeInsert(lastX, lastY);
      if (idx !== insertIndex) {
        insertIndex = idx;
        doReorder(idx);
      }
    }
    function move(ev) {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!rafScheduled) {
        rafScheduled = true;
        rafId = requestAnimationFrame(frame);
      }
    }
    function up(ev) {
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
      card.removeEventListener("pointercancel", up);
      if (rafScheduled) cancelAnimationFrame(rafId);
      if (flipRaf) cancelAnimationFrame(flipRaf);
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
    applyFollow(e.clientX, e.clientY);
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
    wv.dataset.key = key;
    wv.addEventListener("did-fail-load", (e) => {
      if (e.errorCode === -3) return;
      console.warn("webview 加载失败", key, e.errorDescription);
    });
    // DOM 准备好后触发一次 resize，确保 webview 内部内容正确撑满容器
    wv.addEventListener("dom-ready", () => {
      wv.dataset.ready = "1";
      try { wv.send("sync-theme", theme); } catch (e) {} // 加载完成后同步工具箱主题
      // 仍是当前要展示的标签才淡入；否则仅标记就绪，等切回时直接激活（避免黑闪）
      if (wv.dataset.key === activeKey) {
        wv.dataset.pending = "";
        const ft = pendingFallbacks.get(wv.dataset.key);
        if (ft) { clearTimeout(ft); pendingFallbacks.delete(wv.dataset.key); }
        activateWebview(wv);
      } else {
        wv.dataset.pending = ""; // 已就绪，pending 失效
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
    const ft = pendingFallbacks.get(key);
    if (ft) { clearTimeout(ft); pendingFallbacks.delete(key); }
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

  // 激活一个 webview：隐藏 landing + 挂 .active（CSS 淡入微缩放），并触发内部 resize
  function activateWebview(wv) {
    landingEl.classList.add("hidden");
    wv.classList.add("active");
    requestAnimationFrame(() => {
      resizeWebview(wv);
      // 再补一次，兼容某些情况下首帧未生效
      setTimeout(() => resizeWebview(wv), 60);
    });
  }

  // 首次激活兜底：dom-ready 超过 1500ms 仍未触发（如服务未起），且仍是当前目标，
  // 则强制激活——露出 webview（错误页）也好过卡在 landing/空白。
  function scheduleFallbackActivation(wv) {
    const key = wv.dataset.key;
    if (pendingFallbacks.has(key)) return;
    const ft = setTimeout(() => {
      pendingFallbacks.delete(key);
      if (wv.dataset.ready) return;             // 已就绪
      if (wv.dataset.key !== activeKey) return; // 已切走
      wv.dataset.pending = "";
      activateWebview(wv);
    }, 1500);
    pendingFallbacks.set(key, ft);
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
    // 工具页：显示对应 webview
    openTabs.forEach((x) => {
      if (x.key === HOME_KEY) return; // 跳过入口页，它不走 webview
      const wv = document.getElementById("wv-" + x.key);
      if (!wv) return;
      const active = x.key === key;
      if (active) {
        if (!wv.dataset.ready) {
          // 内容未就绪：保持 webview hidden，landing 仍可见（环境光渐变，非黑）；
          // 等 dom-ready 再 activateWebview（内部隐藏 landing + 挂 .active 淡入）
          wv.dataset.pending = "1";
          scheduleFallbackActivation(wv);
        } else {
          activateWebview(wv);
        }
      } else {
        wv.classList.remove("active");
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
    // 防御性：状态系统组件（status-luxe.js 提供的全局函数）若未加载成功，
    // 必须保证卡片渲染与页面可操作，绝不能让状态胶囊的异常阻断整个初始化序列。
    try {
      const kdocsLevel = (serviceStatus.kdocs && serviceStatus.kdocs.running) ? 'ok' : 'off';
      const netdiskLevel = (serviceStatus.netdisk && serviceStatus.netdisk.running) ? 'ok' : 'off';
      const biliupLevel = (serviceStatus.biliup && serviceStatus.biliup.running) ? 'ok' : 'off';
      const materialLevel = (serviceStatus.material && serviceStatus.material.running) ? 'ok' : 'off';
      const agg = (typeof aggregateStatus === "function")
        ? aggregateStatus([kdocsLevel, netdiskLevel, biliupLevel, materialLevel])
        : 'off';
      const colorLevel = (typeof aggColorLevel === "function") ? aggColorLevel(agg) : agg;
      aggEl.innerHTML = (typeof statusHTML === "function")
        ? statusHTML(colorLevel, aggLabel(agg))
        : (aggLabel(agg) || "");
    } catch (e) {
      // 状态胶囊渲染失败不应阻断卡片与页面：回退为纯文本标签，保证 #aggStatus 被替换。
      if (aggEl) aggEl.textContent = aggLabel('off');
    }
    renderCards(); // 无论状态系统是否成功，卡片必须渲染、页面必须可操作
  }
  // 入口聚合标签：err→异常 / off→离线 / warn→需注意 / info→检测中 / ok→全部正常
  function aggLabel(level) {
    switch (level) {
      case 'err': return '异常';
      case 'off': return '离线';
      case 'warn': return '需注意';
      case 'info': return '检测中';
      default: return '全部正常';
    }
  }
  if (api && api.getStatus) {
    api.getStatus().then(renderStatus).catch(() => renderStatus({}));
    if (api.onStatus) api.onStatus(renderStatus);
  } else {
    aggEl.textContent = "未运行在桌面应用环境中";
    renderCards();
  }

  // ── 更新 ──
  /** 提取错误的可读摘要（electron-updater 原始 message 常含 URL/堆栈/HTTP 细节） */
  function cleanErrMsg(raw) {
    if (!raw) return "未知错误";
    const s = String(raw).trim();
    // 只取第一行（真实消息通常在第一行，后面是堆栈或 URL 列表）
    const first = s.split(/\n/)[0].trim();
    // 截断到 80 字符，防止撑爆 UI
    return first.length > 80 ? first.slice(0, 77) + "…" : first;
  }
  function setUpdateUI(text, busy, level) {
    updateStatusEl.innerHTML = level
      ? ((typeof statusHTML === "function") ? statusHTML(level, text || "") : (text || ""))
      : (text || "");
    updateBtn.disabled = !!busy;
    updateBtn.textContent = busy ? "⏳ 检查中…" : (currentVersion ? "v" + currentVersion : "🔄 检测更新");
  }
  if (api && api.onUpdateStatus) {
    api.onUpdateStatus((p) => {
      switch (p.state) {
        case "checking":
          setUpdateUI("正在检查更新…", true, "info");
          break;
        case "available":
          setUpdateUI(`发现新版本 ${p.version}，正在下载…`, true, "info");
          break;
        case "progress":
          setUpdateUI(`下载中 ${Math.round(p.percent || 0)}%`, true, "info");
          break;
        case "downloaded":
          setUpdateUI(`新版本 ${p.version} 已下载`, false, "ok");
          updateBtn.textContent = "🚀 立即安装";
          updateBtn.onclick = () => api.installUpdate && api.installUpdate();
          break;
        case "not-available":
          setUpdateUI("当前已是最新", false, "ok");
          break;
        case "error":
          const msg = cleanErrMsg(p.message);
          // 对已知临时性问题给友好提示
          const hint = /latest\.yml|Cannot find|404|network|timeout/i.test(msg)
            ? "（可能正在构建中，稍后重试）" : "";
          setUpdateUI(`更新失败：${msg}${hint}`, false, "err");
          break;
      }
    });
  }
  updateBtn.onclick = () => {
    if (api && api.checkUpdate) {
      api.checkUpdate().catch((e) => setUpdateUI("检查失败：" + cleanErrMsg(e.message), false, "err"));
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
    const titleEl = document.querySelector(".top-left");
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

  // 状态胶囊光标光斑（info 态 hover 随动）
  if (typeof bindStatusCursor === "function") bindStatusCursor(document);
})();
