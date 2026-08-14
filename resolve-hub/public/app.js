// resolve-hub 前端：选目录 → 开始做视频(0-4) → 手动5-7 → 确认好了(8-9)
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const execCard = $("execCard");
  const execStep = $("execStep");
  const execStepName = $("execStepName");
  const execStepDetail = $("execStepDetail");
  const execLog = $("execLog");
  const dirInput = $("dirInput");
  const infoEl = $("folderInfo");
  const startBtn = $("startBtn");
  const finishBtn = $("finishBtn");
  const clearBtn = $("clearBtn");
  const manualCard = $("manualCard");
  const doneEl = $("done");

  let current = null; // { name, path }
  let logBuf = "";

  function flushLines() {
    const lines = logBuf.split(/\r?\n/);
    logBuf = lines.pop() || "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const cls = /\[错误\]|Traceback|失败/.test(raw) ? "err" : (/完成|成功|✓/.test(raw) ? "ok" : "");
      const div = document.createElement("div");
      div.className = "line" + (cls ? " " + cls : "");
      div.textContent = raw;
      execLog.appendChild(div);
      // 用最新带 [标记 的行刷新步骤详情
      if (/^\[/.test(raw.trim())) {
        execStepDetail.textContent = raw.trim().slice(0, 80);
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
    execStep.classList.remove("info");
    execStep.classList.add(ok ? "ok" : "err");
    execStepName.textContent = ok ? "完成" : "失败";
    execStepDetail.textContent = ok ? "" : "请查看下方日志定位问题。";
  }

  function beginRun(title, detail) {
    execCard.hidden = false;
    execCard.classList.add("show");
    execLog.innerHTML = "";
    logBuf = "";
    execStep.className = "step-item info";
    execStepName.textContent = title;
    execStepDetail.textContent = detail;
  }

  async function refreshInfo() {
    const dir = dirInput.value.trim();
    if (!dir) { infoEl.textContent = ""; startBtn.disabled = true; return; }
    try {
      const r = await fetch("/api/folder-info?dir=" + encodeURIComponent(dir));
      const j = await r.json();
      current = { name: dir.split(/[\\/]/).pop(), path: dir };
      infoEl.innerHTML = "";
      const cover = j.coverOk
        ? '<span class="ok">封面 ✓</span> ' + esc(j.cover)
        : '<span class="bad">封面 ✗（缺 封面.jpg）</span>';
      const trailer = j.trailerOk
        ? '<span class="ok">预告片 ✓</span> ' + esc(j.trailer)
        : '<span class="bad">预告片 ✗（缺视频）</span>';
      infoEl.innerHTML = "项目名：<b>" + esc(current.name) + "</b> · " + cover + " · " + trailer;
      startBtn.disabled = !(j.coverOk && j.trailerOk);
    } catch (e) {
      infoEl.textContent = "素材检测失败";
      startBtn.disabled = true;
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function streamRun(url, body) {
    startBtn.disabled = true;
    finishBtn.disabled = true;
    doneEl.textContent = "";
    let output = "";
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.body) { addLog("请求失败\n"); return; }
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
    }
    finishLog(!/\[错误\]|Traceback|失败/.test(output));
  }

  startBtn.onclick = async () => {
    if (!current) return;
    beginRun("开始做视频（0-4）", "正在连接 Resolve、建项目、导素材、导模板并追加到时间线…");
    await streamRun("/api/start", { dir: current.path });
    manualCard.hidden = false;
    finishBtn.disabled = false;
    startBtn.disabled = false;
    $("startState").textContent = "";
  };

  finishBtn.onclick = async () => {
    if (!current) return;
    beginRun("渲染导出（8-9）", "正在加载导出预设并渲染…");
    await streamRun("/api/render", { project: current.name });
    finishBtn.disabled = false;
    doneEl.textContent = "渲染结束，请检查日志确认输出文件。";
  };

  $("browseBtn").onclick = async () => {
    if (!window.electronAPI || !window.electronAPI.pickFolder) {
      infoEl.textContent = "当前环境不支持原生目录选择。";
      return;
    }
    const res = await window.electronAPI.pickFolder();
    const dir = (res && typeof res === "object" && res.dir)
      || (typeof res === "string" ? res : "");
    if (dir) { dirInput.value = dir; refreshInfo(); }
  };
  clearBtn.onclick = () => {
    dirInput.value = "";
    infoEl.textContent = "";
    execCard.hidden = true;
    execCard.classList.remove("show");
    execLog.innerHTML = "";
    logBuf = "";
    doneEl.textContent = "";
    startBtn.disabled = true;
    finishBtn.disabled = true;
    manualCard.hidden = true;
    current = null;
  };
})();
