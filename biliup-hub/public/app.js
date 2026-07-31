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
      }
    } catch (e) {
      logLine("选择文件失败: " + e.message, "err");
    }
  });

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
      $("cfgSeason").value = cfg.seasonId != null ? cfg.seasonId : "";
      $("cfgSection").value = cfg.sectionId != null ? cfg.sectionId : "";
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

  // ── 保存配置（#3：不再包含 AIGC 字段）──
  $("saveCfgBtn").addEventListener("click", async () => {
    const payload = {
      // tid/copyright/noReprint 用 coerceInt 统一解析：0 是合法值（如 noReprint=0 禁止转载），
      // 不会被 falsy 兜底改写（#noReprint falsy 陷阱修复）。uid/line 保持原逻辑不动。
      tid: coerceInt($("cfgTid").value, 17),
      seasonId: String($("cfgSeason").value || "6918057"),
      sectionId: String($("cfgSection").value || "7630305"),
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
      logLine(j.ok ? "参数已保存" : "保存失败: " + (j.error || ""), j.ok ? "ok" : "err");
      if (j.ok) loadConfig();
    } catch (e) {
      logLine("保存配置失败: " + e.message, "err");
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
      $("loginMask").classList.add("show");
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
    $("loginMask").classList.remove("show");
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
    $("confirmMask").classList.add("show");
  }
  function closeConfirm() { $("confirmMask").classList.remove("show"); }
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
      logLine("🎉 投稿完成！aid=" + (d.aid || "?") + " bvid=" + (d.bvid || "?") + " cid=" + (d.cid || "?") + " 合集=" + (d.season ? "已加" : "否"), "ok");
    } else if (ev.type === "error") {
      setCapsule("err", "失败");
      logLine("❌ 失败@" + (ev.stage || "") + ": " + (ev.message || ""), "err");
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

  // ── 高级参数折叠（#F：按钮切换，初始隐藏；chevron 方向随状态旋转）──
  const advToggle = $("advToggle");
  const advBody = $("advBody");
  if (advToggle && advBody) {
    advToggle.addEventListener("click", () => {
      const isOpen = advBody.style.display !== "none";
      advBody.style.display = isOpen ? "none" : "";
      advToggle.classList.toggle("open", !isOpen);
    });
  }

  // ── 版本号（#B：拉 /api/version 填 verBadge，失败静默保持 "v—"）──
  async function refreshVersion() {
    try {
      const resp = await fetch("/api/version");
      const j = await resp.json();
      const v = j && j.version;
      if (v) $("verBadge").textContent = "v" + v;
    } catch (e) { /* 失败静默：保留占位 "v—" */ }
  }

  // ── 初始化 ──
  loadConfig();
  refreshAccount();
  refreshHealth();
  refreshVersion();
  setInterval(refreshHealth, 20000); // 每 20s 探活
  if (typeof window.bindStatusCursor === "function") window.bindStatusCursor(document);
})();
