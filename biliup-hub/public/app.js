// biliup-hub/public/app.js —— 前端逻辑
// pickFile 选视频 / 参数读写 / 发布模式 + 二次确认 / 消费 /api/upload SSE / 状态胶囊
(function () {
  "use strict";
  const api = window.electronAPI;
  const $ = (id) => document.getElementById(id);

  // ── 状态胶囊 ──
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
  setCapsule("off", "空闲");

  // ── 日志 ──
  function logLine(msg, cls) {
    const box = $("logBox");
    const div = document.createElement("div");
    div.className = "line" + (cls ? " " + cls : "");
    div.textContent = "> " + msg;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  let selectedVideo = "";
  let running = false;

  // ── 选视频 ──
  $("pickBtn").addEventListener("click", async () => {
    try {
      if (!api || !api.pickFile) { logLine("当前环境不支持选择文件（需工具箱内运行）", "err"); return; }
      const r = await api.pickFile();
      if (r && r.filePath) {
        selectedVideo = r.filePath;
        $("videoName").textContent = selectedVideo;
        const base = selectedVideo.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
        $("titlePreview").textContent = base;
        $("titleInput").value = base;
        $("submitHint").textContent = "已选择视频，点击🚀投稿";
      }
    } catch (e) {
      logLine("选择文件失败: " + e.message, "err");
    }
  });

  // ── 发布模式切换 ──
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      $("dtimeInput").disabled = r.value !== "dtime";
    });
  });

  // ── 加载配置 ──
  async function loadConfig() {
    try {
      const resp = await fetch("/api/config");
      const cfg = await resp.json();
      $("cfgTid").value = cfg.tid != null ? cfg.tid : "";
      $("cfgSeason").value = cfg.seasonId != null ? cfg.seasonId : "";
      $("cfgSection").value = cfg.sectionId != null ? cfg.sectionId : "";
      $("cfgCopyright").value = cfg.copyright != null ? cfg.copyright : "";
      $("cfgNoReprint").value = cfg.noReprint != null ? cfg.noReprint : "";
      $("cfgLine").value = cfg.line || "";
      $("cfgUid").value = cfg.uid != null ? cfg.uid : "";
      $("cfgDesc").value = cfg.desc || "";
      $("cfgComment").value = cfg.comment || "";
      const a = cfg.aigc || {};
      $("aigcLabel").value = a.label != null ? a.label : 1;
      $("aigcProducer").value = a.contentProducer || "";
      $("aigcProduceId").value = a.produceId || "";
      $("aigcRc1").value = a.reservedCode1 || "";
      $("aigcPropagator").value = a.contentPropagator || "";
      $("aigcPropagateId").value = a.propagateId || "";
      $("aigcRc2").value = a.reservedCode2 || "";
      const ck = cfg.cookiesDetail || { ok: !!cfg.cookiesOk };
      $("cookiesKpi").textContent = "cookies: " + (ck.ok ? "✅ 有效" : "❌ 缺失 SESSDATA/bili_jct");
      $("cookiesKpi").style.color = ck.ok ? "" : "#ff8a8a";
    } catch (e) {
      logLine("加载配置失败: " + e.message, "err");
    }
  }

  // ── 保存配置 ──
  $("saveCfgBtn").addEventListener("click", async () => {
    const payload = {
      tid: Number($("cfgTid").value) || 17,
      seasonId: String($("cfgSeason").value || "6918057"),
      sectionId: String($("cfgSection").value || "7630305"),
      copyright: Number($("cfgCopyright").value) || 1,
      noReprint: Number($("cfgNoReprint").value) || 1,
      line: $("cfgLine").value || "bda2",
      uid: Number($("cfgUid").value) || 236743002,
      desc: $("cfgDesc").value,
      comment: $("cfgComment").value,
      aigc: {
        label: Number($("aigcLabel").value) || 1,
        contentProducer: $("aigcProducer").value,
        produceId: $("aigcProduceId").value,
        reservedCode1: $("aigcRc1").value,
        contentPropagator: $("aigcPropagator").value,
        propagateId: $("aigcPropagateId").value,
        reservedCode2: $("aigcRc2").value,
      },
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
    $("logBox").innerHTML = "";
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

  loadConfig();
  if (typeof window.bindStatusCursor === "function") window.bindStatusCursor(document);
})();
