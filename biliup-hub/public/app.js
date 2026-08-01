// biliup-hub/public/app.js —— 前端逻辑
// pickFile 选视频 / 参数读写 / 发布模式 + 二次确认 / 消费 /api/upload SSE /
// 状态胶囊(#1) / 投稿日志默认隐藏(#4) / 账号头像+扫码登录(#7) / 健康探活(#5)。
(function () {
  "use strict";
  const api = window.electronAPI;
  const $ = (id) => document.getElementById(id);

  // ── 状态胶囊（#1：清晰状态文案 + 前缀）──
  const STAGE_LABEL = {
    pending: ["info", "准备中"],
    extracting_cover: ["info", "抽帧中"],
    uploading: ["info", "上传中"],
    adding_season: ["info", "合集后置中"],
    commenting: ["info", "评论置顶中"],
    done: ["ok", "成功"],
    error: ["err", "失败"],
  };
  function setCapsule(level, text) {
    const el = $("statusCapsule");
    if (el && typeof window.statusHTML === "function") {
      el.innerHTML = window.statusHTML(level, text, { size: "sm" });
    } else if (el) {
      el.textContent = text;
    }
  }
  function setReady() {
    if (!running) setCapsule("ok", "投稿状态：✅ 就绪（待投稿）");
  }
  function setOffline() {
    if (!running) setCapsule("err", "投稿状态：📴 离线（服务未连接）");
  }
  // 初始：检测中
  setCapsule("info", "投稿状态：检测中…");

  // ── 日志（#4：默认隐藏，点击投稿才展示）──
  function logLine(msg, cls) {
    const box = $("logBox");
    const empty = $("logEmpty");
    if (empty) empty.style.display = "none"; // 首行日志后隐藏空状态提示
    const div = document.createElement("div");
    div.className = "line" + (cls ? " " + cls : "");
    div.textContent = "> " + msg;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ── 轻量 Toast（A2：明暗自动适配，3s 自动消失，复用 pop-in 入场）──
  function toast(msg) {
    let host = $("toastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "toastHost";
      host.className = "toast-host";
      document.body.appendChild(host);
    }
    const isErr = /^❌/.test(msg || "");
    const el = document.createElement("div");
    el.className = "toast pop-in";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="toast-ico"></span><span class="toast-msg"></span>';
    el.querySelector(".toast-ico").textContent = isErr ? "❌" : "✅";
    el.querySelector(".toast-msg").textContent = msg;
    host.appendChild(el);
    // 3s 后淡出移除；reduced-motion 下过渡被全局降级为瞬隐，不影响功能。
    setTimeout(() => {
      el.classList.add("toast-out");
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 3000);
  }

  // ── 统一弹窗机制（P09：openModal/closeModal，来去一致、回到原页、不丢上下文）──
  let activeModal = null;
  function openModal(modalEl) {
    if (!modalEl) return;
    activeModal = modalEl; // 记录当前浮层，关闭即回到下层原页（不切换路由、不重置表单）
    const panel = modalEl.querySelector(".modal");
    if (panel) {
      panel.classList.remove("pop-in");
      void panel.offsetWidth; // 强制 reflow 以重放入场动画
      panel.classList.add("pop-in"); // 复用 macos-motion 的 popIn（reduced-motion 下自动降级）
    }
    modalEl.classList.add("show");
  }
  function closeModal() {
    if (!activeModal) return;
    activeModal.classList.remove("show");
    const panel = activeModal.querySelector(".modal");
    if (panel) panel.classList.remove("pop-in");
    activeModal = null;
  }

  // ── P08：轻量任务历史（localStorage，跨会话持久，无新依赖）──
  const HISTORY_KEY_BILIUP = "toolshub:history:biliup";
  const HISTORY_MAX_BILIUP = 50;
  function loadHistoryBiliup(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]") || []; } catch { return []; }
  }
  function pushHistory(key, ok, title, status) {
    const list = loadHistoryBiliup(key);
    list.unshift({ ts: Date.now(), ok: !!ok, title: title || "（未命名）", status: status || "" });
    if (list.length > HISTORY_MAX_BILIUP) list.length = HISTORY_MAX_BILIUP;
    try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 隐私模式可能抛错，忽略 */ }
  }
  function escapeHtmlBiliup(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let selectedVideo = "";
  let running = false;

  // ── 选视频（#1：文件名只显示在按钮后；标题自动取文件名去扩展名）──
  $("pickBtn").addEventListener("click", async () => {
    try {
      if (!api || !api.pickFile) { logLine("当前环境不支持选择文件（需工具箱内运行）", "err"); return; }
      const r = await api.pickFile();
      if (r && r.filePath) {
        selectedVideo = r.filePath;
        $("videoName").textContent = selectedVideo;
        const base = selectedVideo.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
        $("titleInput").value = base; // 不再重复显示一行文件名
        $("submitHint").textContent = "已选择视频，点击🚀投稿";
        if ($("clearBtn")) $("clearBtn").style.display = ""; // 显示「清空选择」（B）
      }
    } catch (e) {
      logLine("选择文件失败: " + e.message, "err");
    }
  });

  // ── 清空选择（B：点击清空已选文件状态与展示，回到初始态）──
  const clearBtnEl = $("clearBtn");
  if (clearBtnEl) {
    clearBtnEl.addEventListener("click", () => {
      if (!selectedVideo) {
        // #3：未选视频时为安全空操作（轻提示），不报错、不隐藏（常驻于卡片右上角）
        toast("当前没有已选择的视频");
        return;
      }
      selectedVideo = "";
      $("videoName").textContent = "";
      $("titleInput").value = "";
      $("submitHint").textContent = "选择视频后点击投稿（发布前会二次确认模式）";
    });
  }

  // ── 发布模式切换（#C：根据选中显隐 dtimeInput；切到定时发布默认填 +1h）──
  function defaultDtime() {
    // 当前本地时间 + 1 小时，格式 YYYY-MM-DDTHH:mm（本地时区）。
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
      + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      const dtime = $("dtimeInput");
      if (r.value === "dtime") {
        dtime.style.display = "";
        if (!dtime.value) dtime.value = defaultDtime();
      } else {
        dtime.style.display = "none";
      }
    });
  });

  // ── 加载配置 ──
  async function loadConfig() {
    try {
      const resp = await fetch("/api/config");
      const cfg = await resp.json();
      // 分区/版权/转载/线路 已改为 <select>；用 selectPreserve 赋值，避免旧 config 含
      // 非内置选项（如 tid=20）时浏览器取消选中导致静默丢值（#D Bug 修复）。
      selectPreserve($("cfgTid"), cfg.tid != null ? cfg.tid : "");
      // H: 合集/分集改为级联下拉，用 selectPreserve 赋值（兼容旧数字值，不在列表则显示「其它 (val)」）。
      selectPreserve($("cfgSeason"), cfg.seasonId != null ? cfg.seasonId : "");
      selectPreserve($("cfgSection"), cfg.sectionId != null ? cfg.sectionId : "");
      selectPreserve($("cfgCopyright"), cfg.copyright != null ? cfg.copyright : "");
      selectPreserve($("cfgNoReprint"), cfg.noReprint != null ? cfg.noReprint : "");
      selectPreserve($("cfgLine"), cfg.line || "");
      $("cfgUid").value = cfg.uid != null ? cfg.uid : "";
      $("cfgDesc").value = cfg.desc || "";
      $("cfgComment").value = cfg.comment || "";
      const ck = cfg.cookiesDetail || { ok: !!cfg.cookiesOk };
      $("cookiesKpi").textContent = "cookies: " + (ck.ok ? "✅ 有效" : "❌ 缺失 SESSDATA/bili_jct");
      $("cookiesKpi").style.color = ck.ok ? "" : "#ff8a8a";
    } catch (e) {
      logLine("加载配置失败: " + e.message, "err");
    }
  }

  // ── 合集/分集级联下拉（#H）──
  // seasonSections: seasonId -> [{ id, title }]，供分集下拉级联填充。
  let seasonSections = Object.create(null);
  // prevSection: 用户/历史已选分集（优先保留其有效选择）；不传则按当前下拉值。
  function fillSections(seasonId, prevSection) {
    const selSection = $("cfgSection");
    if (!selSection) return null;
    const prev = (prevSection != null) ? String(prevSection) : selSection.value;
    selSection.length = 1; // 仅保留默认空项「不指定分集」
    const secs = seasonSections[seasonId] || [];
    for (const sec of secs) {
      const opt = document.createElement("option");
      opt.value = String(sec.id);
      opt.textContent = (sec.title != null && sec.title !== "") ? sec.title : sec.id;
      selSection.appendChild(opt);
    }
    // 1) 用户/历史已有明确分集选择 → 优先保留（前提是该分集仍属于当前合集）。
    if (prev) {
      selectPreserve(selSection, prev);
      if (selSection.value === prev) return prev;
    }
    // 2) 字段对齐（#问题1 修复）：合集仅一个分集时自动选中，
    //    使「用户只填合集」也能正确对齐到 config.sectionId（后端据此触发合集后置）。
    //    多分集需用户明确选择（不猜测，避免加错分集）；无分集则无需后置。
    const auto = (typeof autoSelectSection === 'function') ? autoSelectSection(secs) : null;
    if (auto) selSection.value = auto;
    return auto || "";
  }
  function refreshSeasons() {
    const selSeason = $("cfgSeason");
    const selSection = $("cfgSection");
    if (!selSeason || !selSection) return Promise.resolve();
    // 记住 loadConfig 已设好的当前值（含可能的「其它 (val)」opt），populate 后回填，避免 value 丢失。
    const prevSeason = selSeason.value;
    const prevSection = selSection.value;
    return fetch("/api/seasons")
      .then((r) => r.json())
      .then((j) => {
        const seasons = (j && Array.isArray(j.seasons)) ? j.seasons : [];
        selSeason.length = 1; // 仅保留默认空项「不使用合集」
        selSection.length = 1;
        seasonSections = Object.create(null);
        for (const s of seasons) {
          const opt = document.createElement("option");
          opt.value = String(s.id);
          opt.textContent = (s.title != null && s.title !== "") ? s.title : s.id;
          selSeason.appendChild(opt);
          seasonSections[s.id] = Array.isArray(s.sections) ? s.sections : [];
        }
        // 回填此前选中的合集（已登录命中真实合集则选中，否则 selectPreserve 追加「其它」）。
        if (prevSeason) selectPreserve(selSeason, prevSeason);
        else selSeason.value = "";
        // 填充分集：fillSections 内部优先保留用户已选分集；无历史选择时由字段对齐自动选中单分集合集。
        fillSections(selSeason.value || prevSeason, prevSection);
      })
      .catch((e) => {
        // 未登录/接口失败：下拉仅留默认空项（上面已清空），不填任何可选项。
        logLine("加载合集列表失败: " + e.message, "err");
      });
  }
  // 合集变更 → 级联填充分集（重置为默认空项）。
  const cfgSeasonEl = $("cfgSeason");
  if (cfgSeasonEl) {
    // 切换合集时清空旧分集并重新级联；单分集合集会自动对齐到分集（#问题1 修复）。
    cfgSeasonEl.addEventListener("change", () => fillSections(cfgSeasonEl.value, ''));
  }

  // ── 保存配置（#3：不再包含 AIGC 字段）──
  $("saveCfgBtn").addEventListener("click", async () => {
    const payload = {
      // tid/copyright/noReprint 用 coerceInt 统一解析：0 是合法值（如 noReprint=0 禁止转载），
      // 不会被 falsy 兜底改写（#noReprint falsy 陷阱修复）。uid/line 保持原逻辑不动。
      tid: coerceInt($("cfgTid").value, 17),
      // H: 空串表示「不使用合集 / 不指定分集」，原样保存空串（不再硬兜底 6918057/7630305）。
      seasonId: String($("cfgSeason").value || ""),
      sectionId: String($("cfgSection").value || ""),
      copyright: coerceInt($("cfgCopyright").value, 1),
      noReprint: coerceInt($("cfgNoReprint").value, 1),
      line: $("cfgLine").value || "bda2",
      uid: Number($("cfgUid").value) || 236743002,
      desc: $("cfgDesc").value,
      comment: $("cfgComment").value,
    };
    try {
      const resp = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await resp.json();
      if (j.ok) {
        logLine("参数已保存", "ok");
        toast("✅ 参数已保存"); // A2：轻量提示
        loadConfig(); // 回填最新值（含转载 noReprint=0 等）
      } else {
        logLine("保存失败: " + (j.error || ""), "err");
        toast("❌ 保存失败");
      }
    } catch (e) {
      logLine("保存配置失败: " + e.message, "err");
      toast("❌ 保存失败");
    }
  });

  // ── 账号区（#7：头像+昵称 / 登录按钮）──
  // 默认头像（内联 SVG：灰色圆底 + 小人剪影），代理失败时兜底，确保不裂图。
  const DEFAULT_AVATAR_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="16" fill="#c8cff0"/>' +
    '<circle cx="16" cy="12" r="6" fill="#6b7299"/>' +
    '<path d="M5 28c0-6 5-9 11-9s11 3 11 9z" fill="#6b7299"/>' +
    '</svg>'
  );
  function renderAccount(info) {
    const box = $("accountArea");
    if (!box) return;
    box.innerHTML = "";
    if (info && info.isLogin) {
      const img = document.createElement("img");
      img.className = "avatar";
      img.id = "avatar";
      const face = (info.face || "").trim();
      // #A：经 /api/avatar 代理绕过防盗链；face 为空则直接用默认头像。
      img.referrerPolicy = 'no-referrer';
      img.src = face ? ('/api/avatar?face=' + encodeURIComponent(face)) : DEFAULT_AVATAR_SVG;
      img.alt = info.uname || "用户";
      img.title = (info.uname || "") + "（点击进入个人空间）";
      img.onerror = () => { img.onerror = null; img.src = DEFAULT_AVATAR_SVG; };
      img.addEventListener("click", () => openSpace(info.mid));
      const name = document.createElement("span");
      name.className = "nick-name";
      name.id = "nickName";
      name.textContent = info.uname || "用户";
      name.title = "点击进入个人空间";
      name.addEventListener("click", () => openSpace(info.mid));
      box.appendChild(img);
      box.appendChild(name);
      // 退出登录按钮（Catch 修复：允许用户自助清除过期登录态，避免卡死）
      const logoutBtn = document.createElement("button");
      logoutBtn.className = "auth-btn";
      logoutBtn.id = "logoutBtn";
      logoutBtn.textContent = "退出登录";
      logoutBtn.title = "清除本机登录凭证并退出登录";
      logoutBtn.addEventListener("click", doLogout);
      box.appendChild(logoutBtn);
    } else {
      const btn = document.createElement("button");
      btn.className = "auth-btn";
      btn.id = "loginBtn";
      btn.textContent = "🔑 登录B站";
      btn.addEventListener("click", openLogin);
      box.appendChild(btn);
    }
  }

  function openSpace(mid) {
    if (!mid) return;
    const url = "https://space.bilibili.com/" + mid;
    if (api && api.openExternal) api.openExternal(url);
    else window.open(url, "_blank");
  }

  async function refreshAccount() {
    try {
      const resp = await fetch("/api/account");
      const info = await resp.json();
      renderAccount(info);
    } catch (e) {
      renderAccount({ isLogin: false });
    }
  }

  // ── 退出登录（Catch 修复）──
  // POST /api/logout → 后端 best-effort 删除 cookies.json + login_info.json（仅凭证，不动 config）。
  // 无论成功失败都重新拉取 /api/account，使账号区回到「未登录/请扫码」并显示二维码登录入口。
  async function doLogout() {
    try {
      const resp = await fetch("/api/logout", { method: "POST" });
      const j = await resp.json().catch(() => ({}));
      if (j && j.ok) toast("✅ 已退出登录");
      else toast("❌ 退出登录失败");
    } catch (e) {
      toast("❌ 退出登录失败: " + e.message);
    } finally {
      refreshAccount(); // 重新渲染账号区（显示登录按钮，二维码入口恢复可用）
      refreshSeasons(); // 登录态失效，清空合集/分集级联下拉
    }
  }

  // ── 扫码登录（#7）──
  let loginTimer = null;
  let loginKey = null;
  async function openLogin() {
    try {
      const resp = await fetch("/api/login/qrcode", { method: "POST" });
      const j = await resp.json();
      if (!j.qrcodeKey) throw new Error(j.error || "获取二维码失败");
      loginKey = j.qrcodeKey;
      $("qrImg").src = j.qrDataUrl;
      $("loginStatus").textContent = "请用 B站手机客户端扫码…";
      openModal($("loginMask")); // P09：统一弹窗机制
      if (loginTimer) clearInterval(loginTimer);
      loginTimer = setInterval(pollLogin, 2000);
    } catch (e) {
      if (window.alert) window.alert("登录发起失败: " + e.message);
    }
  }
  async function pollLogin() {
    if (!loginKey) return;
    try {
      const resp = await fetch("/api/login/poll?key=" + encodeURIComponent(loginKey));
      const j = await resp.json();
      if (j.status === "waiting") {
        $("loginStatus").textContent = "等待扫码…";
      } else if (j.status === "scanned") {
        $("loginStatus").textContent = "已扫码，请在手机上确认…";
      } else if (j.status === "success") {
        stopLogin();
        $("loginStatus").textContent = "登录成功";
        refreshAccount();
        loadConfig(); // cookies 可能已就绪
        refreshSeasons(); // 登录态刷新后重新拉取合集列表并回填选中项
      } else if (j.status === "expired") {
        stopLogin();
        $("loginStatus").textContent = "二维码已过期，请重新点击登录";
      }
    } catch (e) {
      $("loginStatus").textContent = "轮询失败: " + e.message;
    }
  }
  function stopLogin() {
    if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
    loginKey = null;
    closeModal(); // P09：统一弹窗机制，隐藏即回到下层原页
  }
  $("loginClose").addEventListener("click", stopLogin);
  $("loginCancel").addEventListener("click", stopLogin);
  $("loginMask").addEventListener("click", (e) => { if (e.target === $("loginMask")) stopLogin(); });

  // ── 二次确认 ──
  function openConfirm() {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    let text = "将投稿到 B站（UID 236743002）：\n• 视频：" + (selectedVideo || "(未选择)") + "\n• 模式：";
    text += mode === "dtime" ? "定时发布 " + ($("dtimeInput").value || "") : "立即发布";
    $("confirmText").textContent = text;
    openModal($("confirmMask")); // P09：统一弹窗机制
  }
  function closeConfirm() { closeModal(); }
  $("confirmCancel").addEventListener("click", closeConfirm);
  $("confirmMask").addEventListener("click", (e) => { if (e.target === $("confirmMask")) closeConfirm(); });

  // ── 投稿（SSE）──
  async function submit() {
    if (running) return;
    if (!selectedVideo) { logLine("请先选择视频文件", "err"); return; }
    const mode = document.querySelector('input[name="mode"]:checked').value;
    let dtime = 0;
    if (mode === "dtime") {
      const v = $("dtimeInput").value;
      if (!v) { logLine("请填写定时发布时间", "err"); return; }
      dtime = Math.floor(new Date(v).getTime() / 1000);
      if (!dtime || isNaN(dtime)) { logLine("定时时间无效", "err"); return; }
    }
    const tags = ($("tagsInput").value || "")
      .split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      videoPath: selectedVideo,
      title: ($("titleInput").value || "").trim(),
      tags,
      publishMode: mode,
      dtime,
    };

    running = true;
    $("submitBtn").disabled = true;
    // #4 展示日志面板（含标题与空状态）
    $("logWrap").style.display = "";
    $("logBox").innerHTML = "";
    $("logEmpty").style.display = "";
    logLine("开始投稿流程…");
    setCapsule("info", "准备中");

    try {
      const resp = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        logLine("请求失败: " + (j.error || resp.status), "err");
        setCapsule("err", "失败");
        return;
      }
      await consumeSSE(resp);
  } catch (e) {
    logLine("投稿异常: " + e.message, "err");
    setCapsule("err", "失败");
    pushHistory(HISTORY_KEY_BILIUP, false, $("titleInput").value || "（未命名）", "投稿异常");
  } finally {
      running = false;
      $("submitBtn").disabled = false;
      refreshHealth(); // 投稿结束后刷新状态为就绪
    }
  }

  async function consumeSSE(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        chunk.split("\n").forEach((line) => {
          if (line.startsWith("data: ")) {
            const raw = line.slice(6).trim();
            if (!raw) return;
            try { handleEvent(JSON.parse(raw)); } catch (e) { /* ignore */ }
          }
        });
      }
    }
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === "log") {
      logLine(ev.message || "", ev.stage === "error" ? "err" : "");
    } else if (ev.type === "status") {
      const m = STAGE_LABEL[ev.stage] || ["info", ev.stage];
      setCapsule(m[0], m[1]);
      if (ev.message) logLine(ev.message, ev.stage === "error" ? "err" : "stage");
  } else if (ev.type === "done") {
    setCapsule("ok", "成功");
    const d = ev.data || {};
    const ok = d.success !== false;
    logLine("🎉 投稿完成！aid=" + (d.aid || "?") + " bvid=" + (d.bvid || "?") + " cid=" + (d.cid || "?") + " 合集=" + (d.season ? "已加" : "否"), "ok");
    // P08：写一条投稿历史（成功/失败 + 稿件标题 + 时间 + 简要状态）
    pushHistory(HISTORY_KEY_BILIUP, ok, $("titleInput").value || "（未命名）", ok ? ("投稿成功" + (d.bvid ? " · " + d.bvid : "")) : (d.error || "投稿未完成"));
  } else if (ev.type === "error") {
    setCapsule("err", "失败");
    logLine("❌ 失败@" + (ev.stage || "") + ": " + (ev.message || ""), "err");
    // P08：写一条投稿历史（失败）
    pushHistory(HISTORY_KEY_BILIUP, false, $("titleInput").value || "（未命名）", ev.message || "投稿失败");
  }
  }

  $("submitBtn").addEventListener("click", openConfirm);
  $("confirmOk").addEventListener("click", () => { closeConfirm(); submit(); });

  // ── 健康探活（#5：检测服务是否离线）──
  async function refreshHealth() {
    try {
      const resp = await fetch("/api/health");
      if (resp.ok) setReady();
      else setOffline();
    } catch (e) {
      setOffline();
    }
  }

  // ── 高级参数弹窗（A4：点击小按钮弹出独立弹窗页，关闭后回到投稿设置页）──
  const advToggle = $("advTrigger");
  const advMask = $("advMask");
  if (advToggle && advMask) {
    advToggle.addEventListener("click", () => openModal(advMask));
  }
  if (advMask) {
    const advClose = $("advClose");
    if (advClose) advClose.addEventListener("click", closeModal);
    // 点击遮罩空白处关闭，回到原页（不重置表单）
    advMask.addEventListener("click", (e) => { if (e.target === advMask) closeModal(); });
  }

  // ── P08：投稿历史展示（复用 P09 统一弹窗机制）──
  const historyMaskBiliup = $("historyMask");
  const historyListBiliup = $("historyList");
  const historyBtnBiliup = $("submitHistoryBtn");
  const historyCloseBiliup = $("historyClose");
  const historyClearBiliup = $("historyClear");

  function renderBiliupHistory() {
    const list = loadHistoryBiliup(HISTORY_KEY_BILIUP);
    if (!list.length) { historyListBiliup.innerHTML = '<div class="history-empty">还没有投稿记录</div>'; return; }
    historyListBiliup.innerHTML = list.map((h) => {
      const time = new Date(h.ts).toLocaleString("zh-CN");
      const badge = h.ok ? "成功" : "失败";
      return `<div class="history-item">
        <span class="history-dot ${h.ok ? "ok" : "err"}"></span>
        <div class="history-main">
          <div class="history-title">${escapeHtmlBiliup(h.title)}</div>
          <div class="history-meta">${escapeHtmlBiliup(badge + (h.status ? " · " + h.status : ""))} · ${escapeHtmlBiliup(time)}</div>
        </div>
      </div>`;
    }).join("");
  }
  function openBiliupHistory() { renderBiliupHistory(); openModal(historyMaskBiliup); }
  if (historyBtnBiliup) historyBtnBiliup.addEventListener("click", openBiliupHistory);
  if (historyCloseBiliup) historyCloseBiliup.addEventListener("click", closeModal);
  if (historyMaskBiliup) historyMaskBiliup.addEventListener("click", (e) => { if (e.target === historyMaskBiliup) closeModal(); });
  if (historyClearBiliup) historyClearBiliup.addEventListener("click", () => {
    if (window.confirm("确定清空全部投稿历史?")) {
      try { localStorage.removeItem(HISTORY_KEY_BILIUP); } catch { /* ignore */ }
      renderBiliupHistory();
    }
  });

  // ── 版本号（#B：拉 /api/version 填 verBadge，失败静默保持 "v—"）──
  async function refreshVersion() {
    try {
      const resp = await fetch("/api/version");
      const j = await resp.json();
      const v = j && j.version;
      // O: 与 netdisk/kdocs 一致，用 statusHTML 胶囊渲染（✅ 工具箱 vX.Y.Z）；失败静默保留占位 "v—"。
      if (v) {
        $("verBadge").innerHTML = (typeof window.statusHTML === "function")
          ? window.statusHTML('ok', '工具箱 v' + v, { size: 'sm' })
          : ('工具箱 v' + v);
      }
    } catch (e) { /* 失败静默：保留占位 "v—" */ }
  }

  // ── 初始化 ──
  loadConfig();
  refreshSeasons(); // 登录态下拉级联：populate 后排回 loadConfig 已设值
  refreshAccount();
  refreshHealth();
  refreshVersion();
  setInterval(refreshHealth, 20000); // 每 20s 探活
  if (typeof window.bindStatusCursor === "function") window.bindStatusCursor(document);

  // T02：首屏入场编排（零侵入：仅给 .wrap 首屏可见块挂 pop-in + --i，复用内联 macos-motion.css 的 stagger）
  function applyEntrance(scope, max) {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch (e) {}
    const root = scope || document;
    const blocks = Array.from(root.children).filter((el) => {
      if (!el || !el.style) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (el.offsetParent === null) return false; // 不在渲染树（如隐藏面板）跳过
      return true;
    });
    const n = Math.min(max || 6, blocks.length);
    for (let i = 0; i < n; i++) {
      blocks[i].classList.add("pop-in");
      blocks[i].style.setProperty("--i", i);
    }
  }
  applyEntrance(document.querySelector(".wrap"));
})();
