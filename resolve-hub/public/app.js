// resolve-hub 前端：选目录 → 开始做视频(0-4) → 手动5-7 → 确认好了(8-9)
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const logEl = $("log");
  const dirInput = $("dirInput");
  const infoEl = $("folderInfo");
  const startBtn = $("startBtn");
  const finishBtn = $("finishBtn");
  const manualCard = $("manualCard");
  const doneEl = $("done");

  let current = null; // { name, path }

  function addLog(s) {
    if (!s) return;
    logEl.textContent += s;
    logEl.scrollTop = logEl.scrollHeight;
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
    logEl.textContent = "";
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
        addLog(dec.decode(r.value, { stream: true }));
      }
    } catch (e) {
      addLog("[错误] " + e.message + "\n");
    }
  }

  startBtn.onclick = async () => {
    if (!current) return;
    await streamRun("/api/start", { dir: current.path });
    manualCard.hidden = false;
    finishBtn.disabled = false;
    startBtn.disabled = false;
    $("startState").textContent = "";
  };

  finishBtn.onclick = async () => {
    if (!current) return;
    await streamRun("/api/render", { project: current.name });
    finishBtn.disabled = false;
    doneEl.textContent = "渲染结束，请检查日志确认输出文件。";
  };

  $("browseBtn").onclick = async () => {
    if (!window.electronAPI || !window.electronAPI.pickFolder) {
      infoEl.textContent = "当前环境不支持原生目录选择。";
      return;
    }
    const dir = await window.electronAPI.pickFolder();
    if (dir) { dirInput.value = dir; refreshInfo(); }
  };
})();
