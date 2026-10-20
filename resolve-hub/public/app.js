// resolve-hub 前端：选目录 → 开始做视频(0-4) → 手动5-7 → 确认好了(8-9)
// 2026-10 自检修复：退出码判成败、失败可重试、状态持久化、输出名净化、
// 切目录清状态、按所选目录导出、取消任务、警告单独展示、显示输出路径。
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const execCard = $("execCard");
  const execStep = $("execStep");
  const execStepName = $("execStepName");
  const execStepDetail = $("execStepDetail");
  const execSteps = $("execSteps");
  const execLog = $("execLog");
  const dirInput = $("dirInput");
  const infoEl = $("folderInfo");
  const startBtn = $("startBtn");
  const finishBtn = $("finishBtn");
  const cancelBtn = $("cancelBtn");
  const outInput = $("outInput");
  const clearBtn = $("clearBtn");
  const manualCard = $("manualCard");
  const doneEl = $("done");
  const startState = $("startState");
  const outPathRow = $("outPathRow");
  const outPath = $("outPath");
  const openFolderBtn = $("openFolderBtn");
  const selfcheckMask = $("selfcheckMask");
  const selfcheckList = $("selfcheckList");
  const scBack = $("scBack");
  const scContinue = $("scContinue");

  const STATE_KEY = "resolve-hub-state-v1";
  const DEFAULT_SUFFIX = "官方中文+全DLC+免安装硬盘版 免费学习版下载";
  const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
  const EXIT_MARKER = "__RESOLVE_EXIT__";

  let current = null; // { name, path }
  let logBuf = "";
  let running = false;
  let cancelRequested = false;
  let startReady = false;
  let preflightBlocked = false;
  const state = { dir: "", name: "", out: "", phase: "idle", outputPath: "" };

  const STEP_TAGS = [
    { tag: "resolve", name: "0 · 连接 / 启动 Resolve" },
    { tag: "work", name: "0 · 清理临时目录" },
    { tag: "project", name: "1 · 新建 / 加载项目（60fps）" },
    { tag: "trailer", name: "2 · 预告片编码检查" },
    { tag: "素材", name: "2 · 导入封面 + 预告片" },
    { tag: "timeline", name: "3-4 · 导入模板并追加到时间线" },
    { tag: "自检", name: "8 · 渲染前自检" },
    { tag: "render", name: "9 · 渲染导出并校验" },
  ];
  const stepEls = {};

  function collapse(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }
  function sanitizeOutName(raw, project) {
    const proj =
      collapse(String(project || "").replace(ILLEGAL_NAME_CHARS, "_")).slice(0, 100) ||
      "未命名项目";
    let s = String(raw == null ? "" : raw)
      .trim()
      .replace(/\.mp4$/i, "")
      .replace(ILLEGAL_NAME_CHARS, "_");
    s = s.replace(/_{2,}/g, "_");
    s = collapse(s).replace(/^[.\s]+|[.\s]+$/g, "");
    if (!s || s === "." || s === "..") s = proj + " " + DEFAULT_SUFFIX;
    return s.slice(0, 120).trim() || proj + " " + DEFAULT_SUFFIX;
  }
  function defaultOut(project) {
    return sanitizeOutName("", project);
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐私模式忽略 */
    }
  }

  function stepForTag(tag) {
    const def = STEP_TAGS.find((d) => d.tag === tag);
    if (!def) return null;
    if (stepEls[tag]) return stepEls[tag];
    const item = document.createElement("div");
    item.className = "step-item info";
    item.innerHTML =
      '<span class="step-icon"><svg class="app-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>' +
      '<div class="step-body">' +
      '<div class="step-name">' +
      esc(def.name) +
      "</div>" +
      '<div class="step-detail"></div>' +
      "</div>";
    execSteps.appendChild(item);
    stepEls[tag] = item;
    return item;
  }

  function flushLines() {
    const lines = logBuf.split(/\r?\n/);
    logBuf = lines.pop() || "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      if (new RegExp("^" + EXIT_MARKER + "=\\d+$").test(raw.trim())) continue; // 机器标记不进日志
      if (/^__SELFCHECK__=/.test(raw.trim())) continue; // 自检问题 JSON 进弹窗，不进日志
      const isErr = /\[错误\]|Traceback/.test(raw);
      const isWarn = !isErr && /警告|可忽略|缺失/.test(raw);
      const isOk = !isErr && !isWarn && /完成|成功|✓/.test(raw);
      const div = document.createElement("div");
      div.className = "line" + (isErr ? " err" : isWarn ? " warn" : isOk ? " ok" : "");
      div.textContent = raw;
      execLog.appendChild(div);
      const m = raw.trim().match(/^\[([^\]]+)\]/);
      if (m) {
        const item = stepForTag(m[1]);
        if (item) {
          const detail = item.querySelector(".step-detail");
          detail.textContent = raw.trim().slice(0, 120);
          item.classList.remove("info", "ok", "err", "warn");
          item.classList.add(isErr ? "err" : isWarn ? "warn" : isOk ? "ok" : "info");
        }
      }
    }
    execLog.scrollTop = execLog.scrollHeight;
  }

  function addLog(s) {
    if (!s) return;
    logBuf += s;
    flushLines();
  }

  function finishLog(ok) {
    flushLines();
    execStep.classList.remove("info", "ok", "err", "warn");
    execStep.classList.add(ok ? "ok" : "err");
    execStepName.textContent = ok ? "完成" : cancelRequested ? "已停止" : "失败";
    execStepDetail.textContent = ok
      ? ""
      : cancelRequested
        ? "任务已被手动停止。"
        : "请查看下方日志定位问题。";
    const cls = ok ? "ok" : "err";
    execSteps.querySelectorAll(".step-item.info").forEach((el) => {
      el.classList.remove("info");
      el.classList.add(cls);
    });
  }

  function finishLogNeutral(title, detail) {
    flushLines();
    execStep.classList.remove("info", "ok", "err", "warn");
    execStep.classList.add("warn");
    execStepName.textContent = title || "等待确认";
    execStepDetail.textContent = detail || "";
    execSteps.querySelectorAll(".step-item.info").forEach((el) => {
      el.classList.remove("info");
      el.classList.add("warn");
    });
  }

  function beginRun(title, detail) {
    execCard.hidden = false;
    execCard.classList.add("show");
    execLog.innerHTML = "";
    execSteps.innerHTML = "";
    Object.keys(stepEls).forEach((k) => delete stepEls[k]);
    logBuf = "";
    execStep.className = "step-item info";
    execStepName.textContent = title;
    execStepDetail.textContent = detail;
    cancelRequested = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }

  function setButtons() {
    startBtn.disabled = running || !startReady;
    finishBtn.disabled = running || state.phase !== "setup_done";
    if (cancelBtn) cancelBtn.hidden = !running;
  }

  function resetRunState() {
    state.phase = "idle";
    state.outputPath = "";
    manualCard.hidden = true;
    finishBtn.textContent = "确认好了，继续导出（8-9）";
    doneEl.textContent = "";
    execCard.hidden = true;
    execCard.classList.remove("show");
    execLog.innerHTML = "";
    execSteps.innerHTML = "";
    Object.keys(stepEls).forEach((k) => delete stepEls[k]);
    logBuf = "";
    if (outPathRow) outPathRow.hidden = true;
    if (outPath) outPath.textContent = "";
    setButtons();
  }

  function applyPhase() {
    if (state.phase === "setup_done") {
      manualCard.hidden = false;
      finishBtn.textContent = "确认好了，继续导出（8-9）";
    } else if (state.phase === "done") {
      manualCard.hidden = false;
      finishBtn.textContent = "已导出完成";
      if (state.outputPath && outPathRow) {
        outPath.textContent = state.outputPath;
        outPathRow.hidden = false;
      }
    } else {
      manualCard.hidden = true;
    }
    setButtons();
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  async function refreshInfo(opts = {}) {
    const dir = dirInput.value.trim();
    if (!dir) {
      infoEl.textContent = "";
      startReady = false;
      current = null;
      resetRunState();
      return;
    }
    let j = null;
    try {
      const r = await fetch("/api/folder-info?dir=" + encodeURIComponent(dir));
      j = await r.json();
    } catch (e) {
      j = { ok: false, error: "素材检测失败" };
    }
    if (!j || j.ok === false) {
      current = null;
      infoEl.textContent = (j && j.error) || "目录不可读";
      startReady = false;
      setButtons();
      return;
    }
    const prev = current && current.path;
    const name = j.projectName || dir.split(/[\\/]/).filter(Boolean).pop() || "未命名项目";
    current = { name, path: dir };
    if (prev !== dir) {
      resetRunState();
      state.dir = dir;
      state.name = name;
      state.out = j.defaultOut || defaultOut(name);
      outInput.value = state.out;
      saveState();
    } else if (!outInput.value.trim()) {
      state.out = j.defaultOut || defaultOut(name);
      outInput.value = state.out;
    }
    const cover = j.coverOk
      ? '<span class="ok">封面 ✓</span> ' + esc(j.cover)
      : '<span class="bad">封面 ✗（缺 封面.jpg）</span>';
    const trailer = j.trailerOk
      ? '<span class="ok">预告片 ✓</span> ' + esc(j.trailer)
      : '<span class="bad">预告片 ✗（缺视频）</span>';
    infoEl.innerHTML = "项目名：<b>" + esc(name) + "</b> · " + cover + " · " + trailer;
    startReady = !!(j.coverOk && j.trailerOk) && !preflightBlocked;
    setButtons();
    if (opts.consoleHint === false) return;
  }

  function parseExitMarker(text) {
    const m = String(text || "").match(new RegExp(EXIT_MARKER + "=(\\d+)", "g"));
    if (!m || !m.length) return null;
    return Number(m[m.length - 1].split("=")[1]);
  }
  function stripExitMarker(text) {
    return String(text || "").replace(new RegExp("\\n?" + EXIT_MARKER + "=\\d+\\n?", "g"), "\n");
  }

  async function streamRun(url, body) {
    running = true;
    cancelRequested = false;
    setButtons();
    let output = "";
    let exitCode = null;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        let msg = "请求失败（HTTP " + resp.status + "）";
        try {
          const j = await resp.json();
          if (j && j.error) msg = j.error;
        } catch (e) {
          /* ignore */
        }
        addLog("[错误] " + msg + "\n");
        output = "[错误] " + msg + "\n";
        finishLog(false);
        return { ok: false, exitCode: null, output };
      }
      if (!resp.body) {
        addLog("[错误] 请求失败：无响应内容\n");
        finishLog(false);
        return { ok: false, exitCode: null, output: "[错误] 请求失败：无响应内容\n" };
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder("utf-8");
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        const chunk = dec.decode(r.value, { stream: true });
        output += chunk;
        addLog(chunk);
      }
    } catch (e) {
      addLog("[错误] " + e.message + "\n");
      output += "[错误] " + e.message + "\n";
    } finally {
      running = false;
      setButtons(); // HTTP 400/409 等提前返回时也要恢复按钮
    }
    exitCode = parseExitMarker(output);
    output = stripExitMarker(output);
    if (exitCode === 3) {
      running = false;
      setButtons();
      finishLogNeutral("等待确认：自检发现问题", "请选择「返回修改」或「仍然渲染」。");
      return { ok: false, exitCode, output };
    }
    const ok =
      exitCode !== null
        ? exitCode === 0 && !cancelRequested
        : !/\[错误\]|Traceback/.test(output) && !cancelRequested;
    finishLog(ok);
    setButtons();
    return { ok, exitCode, output };
  }

  startBtn.onclick = async () => {
    if (!current || running) return;
    state.dir = current.path;
    state.name = current.name;
    state.out = sanitizeOutName(outInput.value, current.name);
    outInput.value = state.out;
    state.phase = "idle";
    saveState();
    beginRun("开始做视频（0-4）", "正在连接 Resolve、建项目、导素材、导模板并追加到时间线…");
    const res = await streamRun("/api/start", { dir: current.path, project: current.name });
    if (res.ok) {
      state.phase = "setup_done";
      saveState();
      doneEl.textContent = "已完成 0-4。请到 DaVinci 完成手动 5-7，然后点下方按钮导出。";
    } else {
      doneEl.textContent = "0-4 未完成，请按日志修正后重试。";
    }
    applyPhase();
  };

  function showSelfcheck(output) {
    let issues = [];
    const m = String(output).match(/__SELFCHECK__=(\[[^\n]*\])/);
    if (m) {
      try {
        issues = JSON.parse(m[1]);
      } catch (e) {
        issues = [];
      }
    }
    if (selfcheckList) {
      selfcheckList.innerHTML = (issues.length ? issues : ["自检未通过"])
        .map((s) => "<li>" + esc(s) + "</li>")
        .join("");
    }
    if (selfcheckMask) selfcheckMask.hidden = false;
    doneEl.textContent = "渲染前自检发现问题：请选择「返回修改」或「仍然渲染」。";
  }

  async function runRender(force) {
    if (!current || running) return;
    const out = sanitizeOutName(outInput.value, current.name);
    outInput.value = out;
    state.out = out;
    saveState();
    beginRun(
      force ? "渲染导出（8-9，已跳过自检）" : "渲染导出（8-9）",
      force ? "正在加载导出预设并渲染…" : "先做渲染前自检，通过后开始渲染…",
    );
    const res = await streamRun("/api/render", {
      project: current.name,
      out,
      target: current.path,
      force: !!force,
    });
    if (res.exitCode === 3) {
      // 自检有问题：停下来让用户选择，而不是直接开渲染
      state.phase = "setup_done";
      saveState();
      showSelfcheck(res.output);
      applyPhase();
      return;
    }
    const m = res.output.match(/\[render\] 完成：(.+?)（\d+ bytes）/);
    if (res.ok && m) {
      state.phase = "done";
      state.outputPath = m[1];
      saveState();
      doneEl.textContent = "渲染完成。";
      outPath.textContent = m[1];
      outPathRow.hidden = false;
      openFolderBtn.disabled = !(window.electronAPI && window.electronAPI.revealInFolder);
    } else if (res.ok) {
      state.phase = "done";
      saveState();
      doneEl.textContent = "渲染完成（未解析到输出路径，请到素材目录查看）。";
    } else {
      // 关键修复：失败后恢复「确认好了继续导出」，否则只能重跑 0-4
      state.phase = "setup_done";
      saveState();
      doneEl.textContent = cancelRequested ? "已停止渲染。" : "渲染失败，请修正后重试。";
    }
    applyPhase();
  }

  finishBtn.onclick = () => runRender(false);

  if (scBack) {
    scBack.onclick = () => {
      if (selfcheckMask) selfcheckMask.hidden = true;
      doneEl.textContent = "已返回修改：完成手动步骤后再点「确认好了，继续导出」。";
      applyPhase();
    };
  }
  if (scContinue) {
    scContinue.onclick = () => {
      if (selfcheckMask) selfcheckMask.hidden = true;
      runRender(true);
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      if (!running) return;
      cancelRequested = true;
      cancelBtn.disabled = true;
      try {
        await fetch("/api/cancel", { method: "POST" });
      } catch (e) {
        /* 忽略 */
      }
    };
  }

  if (openFolderBtn) {
    openFolderBtn.onclick = () => {
      const p = state.outputPath;
      if (!p) return;
      if (window.electronAPI && window.electronAPI.revealInFolder) {
        window.electronAPI.revealInFolder(p);
      } else {
        doneEl.textContent = "当前环境不支持打开文件夹：" + p;
      }
    };
  }

  $("browseBtn").onclick = async () => {
    if (!window.electronAPI || !window.electronAPI.pickFolder) {
      infoEl.textContent = "当前环境不支持原生目录选择。";
      return;
    }
    const res = await window.electronAPI.pickFolder();
    const dir = (res && typeof res === "object" && res.dir) || (typeof res === "string" ? res : "");
    if (dir) {
      dirInput.value = dir;
      await refreshInfo();
    }
  };

  clearBtn.onclick = () => {
    dirInput.value = "";
    infoEl.textContent = "";
    current = null;
    startReady = false;
    state.dir = "";
    state.name = "";
    state.out = "";
    state.phase = "idle";
    state.outputPath = "";
    saveState();
    outInput.value = "";
    startState.textContent = "";
    resetRunState();
  };

  // ── 启动：恢复上次状态 + 预检 ──
  async function loadPreflight() {
    let info = null;
    try {
      info = await (await fetch("/api/preflight")).json();
    } catch (e) {
      info = null;
    }
    const problems = [];
    if (info) {
      if (!info.python || !info.python.ok)
        problems.push("未找到 Python 3（可在环境变量 RESOLVE_PYTHON 指定）");
      if (!info.template || !info.template.ok)
        problems.push("时间线模板缺失：" + ((info.template && info.template.path) || ""));
      if (!info.resolveExe || !info.resolveExe.ok)
        problems.push("未找到 Resolve.exe（若 Resolve 已在运行可忽略）");
    }
    startState.textContent = problems.join("；");
    startState.className = problems.length ? "info bad" : "info";
    preflightBlocked = !!(
      info &&
      ((info.python && !info.python.ok) || (info.template && !info.template.ok))
    );
    if (preflightBlocked) {
      startReady = false;
      setButtons();
    }
    return info;
  }

  async function syncRunning() {
    try {
      const s = await (await fetch("/api/status")).json();
      if (s && s.busy) {
        running = true;
        setButtons();
        startState.textContent =
          "后台有任务正在执行（" + (s.kind || "任务") + "，" + (s.elapsedSec || 0) + "s）…";
        setTimeout(syncRunning, 5000);
        return;
      }
      if (running) {
        running = false;
        setButtons();
        startState.textContent = "";
      }
    } catch (e) {
      /* ignore */
    }
  }

  (async function init() {
    const saved = loadState();
    const savedPhase = (saved && saved.phase) || "idle";
    if (saved && saved.dir) {
      dirInput.value = saved.dir;
      state.phase = savedPhase;
      state.outputPath = saved.outputPath || "";
      state.out = saved.out || "";
    }
    if (current === null && dirInput.value.trim()) {
      await refreshInfo({ restore: true });
      if (current) {
        state.phase = savedPhase; // refreshInfo 会按「新目录」重置一次，这里恢复上次阶段
        if (saved && saved.out) {
          state.out = saved.out;
          outInput.value = saved.out;
        }
        state.dir = current.path;
        state.name = current.name;
        saveState();
      }
      applyPhase();
    }
    await loadPreflight();
    await syncRunning();
  })();

  if (outInput && typeof outInput.addEventListener === "function") {
    outInput.addEventListener("input", () => {
      state.out = outInput.value;
      saveState();
    });
  }
})();
