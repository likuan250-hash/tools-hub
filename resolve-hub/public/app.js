// resolve-hub 前端：选目录 → 开始做视频(0-4) → 手动5-7 → 确认好了(8-9)
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
  const outInput = $("outInput");
  const clearBtn = $("clearBtn");
  const manualCard = $("manualCard");
  const doneEl = $("done");

  let current = null; // { name, path }
  let logBuf = "";
  /** 日志 [标签] → 分步骤展示（0-4 / 8-9 每步一条）。 */
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
      const cls = /\[错误\]|Traceback|失败/.test(raw) ? "err" : /完成|成功|✓/.test(raw) ? "ok" : "";
      const div = document.createElement("div");
      div.className = "line" + (cls ? " " + cls : "");
      div.textContent = raw;
      execLog.appendChild(div);
      // [标签] 行同步刷新对应分步骤的名称/详情/状态
      const m = raw.trim().match(/^\[([^\]]+)\]/);
      if (m) {
        const item = stepForTag(m[1]);
        if (item) {
          const detail = item.querySelector(".step-detail");
          detail.textContent = raw.trim().slice(0, 90);
          if (/\[错误\]|Traceback|失败/.test(raw)) {
            item.classList.remove("info");
            item.classList.add("err");
          } else if (/完成|成功|✓/.test(raw)) {
            item.classList.remove("info");
            item.classList.add("ok");
          }
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
    execStep.classList.remove("info");
    execStep.classList.add(ok ? "ok" : "err");
    execStepName.textContent = ok ? "完成" : "失败";
    execStepDetail.textContent = ok ? "" : "请查看下方日志定位问题。";
    // 未收尾的分步骤收敛为与总结果一致，避免悬挂在「进行中」
    const cls = ok ? "ok" : "err";
    execSteps.querySelectorAll(".step-item.info").forEach((el) => {
      el.classList.remove("info");
      el.classList.add(cls);
    });
  }

  function beginRun(title, detail) {
    execCard.hidden = false;
    execCard.classList.add("show");
    execLog.innerHTML = "";
    execSteps.innerHTML = "";
    Object.keys(stepEls).forEach((k) => {
      delete stepEls[k];
    });
    logBuf = "";
    execStep.className = "step-item info";
    execStepName.textContent = title;
    execStepDetail.textContent = detail;
  }

  async function refreshInfo() {
    const dir = dirInput.value.trim();
    if (!dir) {
      infoEl.textContent = "";
      startBtn.disabled = true;
      return;
    }
    try {
      const r = await fetch("/api/folder-info?dir=" + encodeURIComponent(dir));
      const j = await r.json();
      if (j && j.ok === false) {
        current = null;
        outInput.value = "";
        infoEl.textContent = j.error || "目录不可读";
        startBtn.disabled = true;
        return;
      }
      current = { name: dir.split(/[\\/]/).pop(), path: dir };
      outInput.value = current.name + " 官方中文+全DLC+免安装硬盘版 免费学习版下载";
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
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  async function streamRun(url, body) {
    startBtn.disabled = true;
    finishBtn.disabled = true;
    doneEl.textContent = "";
    let output = "";
    let ok = true;
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
        output += "[错误] " + msg + "\n";
        addLog("[错误] " + msg + "\n");
        ok = false;
        finishLog(false);
        return;
      }
      if (!resp.body) {
        output += "[错误] 请求失败：无响应内容\n";
        addLog("[错误] 请求失败：无响应内容\n");
        ok = false;
        finishLog(false);
        return;
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
      ok = false;
    }
    ok = ok && !/\[错误\]|Traceback|失败/.test(output);
    finishLog(ok);
    return ok;
  }

  startBtn.onclick = async () => {
    if (!current) return;
    beginRun("开始做视频（0-4）", "正在连接 Resolve、建项目、导素材、导模板并追加到时间线…");
    const ok = await streamRun("/api/start", { dir: current.path });
    if (ok) {
      manualCard.hidden = false;
      finishBtn.disabled = false;
    }
    startBtn.disabled = false;
    $("startState").textContent = "";
  };

  finishBtn.onclick = async () => {
    if (!current) return;
    beginRun("渲染导出（8-9）", "正在加载导出预设并渲染…");
    const out = outInput.value.trim();
    const ok = await streamRun(
      "/api/render",
      out ? { project: current.name, out } : { project: current.name },
    );
    if (ok) {
      finishBtn.disabled = true;
      finishBtn.textContent = "已导出完成";
      doneEl.textContent = "渲染完成，输出已写入素材目录。";
    } else {
      doneEl.textContent = "渲染失败，请修正后重试。";
    }
  };

  $("browseBtn").onclick = async () => {
    if (!window.electronAPI || !window.electronAPI.pickFolder) {
      infoEl.textContent = "当前环境不支持原生目录选择。";
      return;
    }
    const res = await window.electronAPI.pickFolder();
    const dir = (res && typeof res === "object" && res.dir) || (typeof res === "string" ? res : "");
    if (dir) {
      dirInput.value = dir;
      refreshInfo();
    }
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
    finishBtn.textContent = "确认好了，继续导出（8-9）";
    manualCard.hidden = true;
    outInput.value = "";
    current = null;
  };
})();
