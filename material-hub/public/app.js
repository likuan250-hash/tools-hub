// material-hub/public/app.js —— 前端交互 + SSE 客户端
// 契约：POST /api/collect {name} → text/event-stream，每条 `data: <JSON>\n\n`（设计 §3.2）。
// SSE 解析逻辑与 kdocs-tool/public/app.js 逐段对齐（buf.indexOf("\n\n") 切分 + `data: ` 前缀 + JSON.parse）。
// 主题不在本页处理：webview-preload.js 注入 data-theme 并隐藏 #themeBtn（本页也不渲染主题按钮）。

/**
 * 取 DOM 节点。
 * @param {string} id 元素 id
 * @returns {HTMLElement}
 */
function $(id) { return document.getElementById(id); }

const gameName = $("gameName");
const collectBtn = $("collectBtn");
const formError = $("formError");
const forceTrailerCb = $("forceTrailer");
const forceCoverCb = $("forceCover");
const coverUrlInput = $("coverUrl");
const stateTabs = $("stateTabs");
const autoSteps = $("autoSteps");
const autoLog = $("autoLog");
const doneSummary = $("doneSummary");
const coverPreview = $("coverPreview");
const coverName = $("coverName");
const coverDim = $("coverDim");
const doneFiles = $("doneFiles");
const pathLine = $("pathLine");
const verText = $("verText");

/** 三态面板 id 映射（与 index.html 一致）。 */
const PANELS = { empty: "panel-empty", running: "panel-running", done: "panel-done" };

/** 步骤时间线固定三段（与设计 §3.2 的事件分组一一对应）。 */
const STEP_ORDER = ["scan", "cover", "trailer"];
const STEP_NAMES = {
  scan: "扫描编号并创建文件夹",
  cover: "下载封面",
  trailer: "下载官方宣传片",
  flow: "素材搜集",
};
/** 事件 type → 步骤分组。 */
const GROUP_OF_TYPE = {
  scan: "scan",
  cover_search: "cover",
  cover_download: "cover",
  cover_extract: "cover",
  trailer_search: "trailer",
  trailer_download: "trailer",
  trailer_transcode: "trailer",
  trailer_probe: "trailer",
};
/** 状态等级 → 中文标签（无符号，状态由步骤徽标 SVG 与配色承载，全站零 emoji / 零字符符号）。 */
const LEVEL_LABEL = { ok: "完成", err: "失败", info: "进行中", warn: "注意", off: "待执行" };

/** 封面来源标识 → 中文展示名（与 lib/cover.js SOURCE_LABEL 对齐）。 */
const COVER_SOURCE_LABEL = {
  "4kwallpapers": "4kwallpapers.com",
  alphacoders: "alphacoders.com",
  wallhaven: "wallhaven.cc",
  user: "用户指定 URL",
  nintendo: "Nintendo 官网",
  "game-sites": "游戏媒体站",
  "chinese-sites": "中文游戏站",
  reddit: "Reddit 社区",
  youtube: "YouTube 缩略图",
  "ffmpeg-frame": "主视频抽帧",
  reused: "复用已有封面",
  unknown: "未知来源",
};
/**
 * 封面来源展示名。
 * @param {string} source 来源标识
 * @returns {string}
 */
function coverSourceLabel(source) {
  return COVER_SOURCE_LABEL[source] || source || "未知来源";
}

/** 步骤徽标图标（统一 SVG 系统，零 emoji）。 */
const ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 3v9" stroke-linecap="round"/><path d="M7 12a5 5 0 1 0 10 0" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M12 7v6" stroke-linecap="round"/><path d="M12 17h.01" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>',
};

/**
 * 结果摘要前置状态图标（零 emoji，统一 SVG 系统）。
 * @param {string} level ok|warn|fail
 * @returns {string} SVG 片段
 */
function summaryIcon(level) {
  if (level === "ok") return window.ico("check");
  if (level === "warn") return window.ico("warning");
  if (level === "fail") return window.ico("cross");
  return window.ico("dot");
}

/** 步骤运行时状态：group → {level, detail}。 */
const stepState = {};
/** 已渲染的步骤节点缓存，便于「进行中 → 完成」原地更新。 */
const stepEls = {};
/** 是否有请求在执行中（防重复点击）。 */
let running = false;

/**
 * HTML 转义（所有服务端文本进 innerHTML 前必须过一遍）。
 * @param {string} s 原始文本
 * @returns {string}
 */
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/**
 * 生成状态标签（承载 .st-luxe--{level}，供 style.css 的 :has() 给徽标/连接线取色）。
 * @param {string} level ok|info|warn|err|off
 * @param {string} text 标签文字
 * @returns {string} HTML 片段
 */
function statusTag(level, text) {
  return '<span class="st-luxe st-luxe--' + level + '" role="status" aria-label="' + esc(text) + '">' + esc(text) + "</span>";
}

/**
 * 切换三态面板。
 * @param {string} state empty|running|done
 */
function setState(state) {
  const tabs = stateTabs.querySelectorAll("button");
  tabs.forEach((t) => {
    t.classList.toggle("active", t.dataset.state === state);
  });
  Object.keys(PANELS).forEach((k) => {
    $(PANELS[k]).classList.toggle("show", k === state);
  });
}

/**
 * 解锁某个状态 tab（内容就绪后才允许点击查看）。
 * @param {string} state empty|running|done
 */
function enableTab(state) {
  const btn = stateTabs.querySelector('button[data-state="' + state + '"]');
  if (btn) btn.disabled = false;
}

/**
 * 追加一行运行日志。
 * @param {string} type info|ok|err
 * @param {string} msg 日志文本
 */
function addLog(type, msg) {
  const div = document.createElement("div");
  div.className = "line " + type;
  div.textContent = msg;
  autoLog.appendChild(div);
  autoLog.scrollTop = autoLog.scrollHeight;
}

/**
 * 渲染（或原地更新）单个步骤节点。
 * @param {string} group scan|cover|trailer|flow
 */
function renderStep(group) {
  const st = stepState[group] || { level: "off", detail: "" };
  let item = stepEls[group];
  if (!item) {
    item = document.createElement("div");
    item.className = "step-item";
    autoSteps.appendChild(item);
    stepEls[group] = item;
  }
  const label = LEVEL_LABEL[st.level] || LEVEL_LABEL.off;
  item.innerHTML =
    '<span class="step-icon">' + (ICONS[st.level] || ICONS.off) + "</span>" +
    '<div class="step-body">' +
      '<div class="step-name">' + esc(STEP_NAMES[group] || group) + " " + statusTag(st.level, label) + "</div>" +
      (st.detail ? '<div class="step-detail">' + st.detail + "</div>" : "") +
    "</div>";
}

/**
 * 事件 ok 字段 → 状态等级（设计 §3.2 前端映射约定）。
 * @param {boolean|null|undefined} ok
 * @returns {string} ok|err|info
 */
function levelOf(ok) {
  if (ok === true) return "ok";
  if (ok === false) return "err";
  return "info";
}

/**
 * 依据一条 SSE 事件更新对应步骤。
 * @param {string} group 步骤分组
 * @param {object} ev SSE 事件
 */
function applyStep(group, ev) {
  const cur = stepState[group] || { level: "off", detail: "" };
  const incoming = levelOf(ev.ok);
  // 终态（ok/err）不被后续「进行中」事件回退，只更新描述文本
  const level = incoming === "info" && (cur.level === "ok" || cur.level === "err") ? cur.level : incoming;
  let detail = esc(ev.msg || "");
  if (level === "ok") detail = '<span class="ok">' + detail + "</span>";
  if (level === "err") detail = '<span class="err">' + detail + "</span>";
  const d = ev.detail || {};
  if (d.folder) detail += " · " + esc(d.folder + "\\");
  if (d.guidance) detail += "<br>安装引导：" + esc(d.guidance);
  stepState[group] = { level, detail };
  renderStep(group);
}

/**
 * 重置执行面板到「全部待执行」。
 */
function resetPanels() {
  autoSteps.innerHTML = "";
  autoLog.innerHTML = "";
  doneFiles.innerHTML = "";
  pathLine.textContent = "";
  doneSummary.className = "result-summary";
  doneSummary.textContent = "执行中…";
  coverPreview.classList.remove("missing");
  coverName.textContent = "封面待获取";
  coverDim.textContent = "";
  Object.keys(stepEls).forEach((k) => { delete stepEls[k]; });
  Object.keys(stepState).forEach((k) => { delete stepState[k]; });
  STEP_ORDER.forEach((g) => {
    stepState[g] = { level: "off", detail: "" };
    renderStep(g);
  });
  formError.textContent = "";
}

/**
 * 渲染完成态（封面预览 + 产物卡片 + 落盘路径）。
 * @param {object} ev done 事件
 */
function renderDone(ev) {
  const d = ev.detail || {};
  const cover = d.cover || null;
  const trailer = d.trailer || null;

  // 摘要：封面是硬指标（缺封面 = 整体失败）；封面在但宣传片缺 = 黄警，不假装全绿
  if (ev.ok === true && d.trailerOk) {
    doneSummary.className = "result-summary ok";
    doneSummary.innerHTML = summaryIcon("ok") + " " + esc((ev.step || "素材搜集完成") + " · " + (ev.msg || ""));
  } else if (ev.ok === true) {
    doneSummary.className = "result-summary warn";
    doneSummary.innerHTML = summaryIcon("warn") + " " + esc((ev.step || "素材搜集完成") + " · " + (ev.msg || ""));
  } else {
    doneSummary.className = "result-summary fail";
    doneSummary.innerHTML = summaryIcon("fail") + " " + esc((ev.step || "素材搜集未完成") + " · " + (ev.msg || ""));
  }

  // 封面预览（本地磁盘文件不能经 http origin 直读，按原型以占位卡呈现元数据）
  if (cover && cover.file) {
    coverPreview.classList.remove("missing");
    coverName.textContent = cover.file;
    coverDim.textContent = (cover.width || "?") + " × " + (cover.height || "?") +
      " · " + coverSourceLabel(cover.source) +
      (cover.degraded ? "（降级图）" : "") +
      (cover.reused ? "（复用）" : "");
  } else {
    coverPreview.classList.add("missing");
    coverName.textContent = "封面缺失";
    coverDim.textContent = "所有封面来源均未取到";
  }

  // 产物卡片
  const cards = [];
  if (trailer && trailer.file) {
    cards.push(
      '<div class="file-card"><div class="play"><i class="app-ico" data-ico="play"></i></div><div class="meta">' +
      '<div class="fname">' + esc(trailer.file) + "</div>" +
      '<div class="fsub">' + esc(trailer.title || "官方宣传片") + (trailer.converted ? " · 已转码 .webm → .mp4" : "") + "</div>" +
      "</div></div>"
    );
  } else {
    cards.push(
      '<div class="file-card"><div class="play missing"><i class="app-ico" data-ico="cross"></i></div><div class="meta">' +
      '<div class="fname">宣传片未获取</div><div class="fsub">见「执行中」面板的失败原因与安装引导</div>' +
      "</div></div>"
    );
  }
  if (cover && cover.file) {
    cards.push(
      '<div class="file-card"><div class="play cover"><i class="app-ico" data-ico="image"></i></div><div class="meta">' +
      '<div class="fname">' + esc(cover.file) + "</div>" +
      '<div class="fsub">' + esc(coverSourceLabel(cover.source)) +
      (cover.degraded ? " · 降级图" : "") +
      (cover.reused ? " · 复用" : "") +
      " · " + esc((cover.width || "?") + " × " + (cover.height || "?")) + "</div>" +
      "</div></div>"
    );
  } else {
    cards.push(
      '<div class="file-card"><div class="play missing"><i class="app-ico" data-ico="cross"></i></div><div class="meta">' +
      '<div class="fname">封面未获取</div><div class="fsub">所有封面来源（壁纸站 / 官网 / YouTube / 主视频抽帧）均获取失败</div>' +
      "</div></div>"
    );
  }
  doneFiles.innerHTML = cards.join("");
  window.hydrateIcons(doneFiles);

  // 落盘路径
  const files = [];
  if (cover && cover.file) files.push(cover.file);
  if (trailer && trailer.file) files.push(trailer.file);
  pathLine.textContent = d.folder
    ? d.folder + "\\" + (files.length ? "  →  " + files.join("  ·  ") : "  →  （无产物）")
    : "（未创建文件夹）";

  // 未收到终态的步骤统一收敛为失败，避免动画悬挂
  STEP_ORDER.forEach((g) => {
    const st = stepState[g];
    if (st && st.level !== "ok" && st.level !== "err") {
      stepState[g] = { level: "err", detail: st.detail || '<span class="err">未完成</span>' };
      renderStep(g);
    }
  });
}

/**
 * 执行一次素材搜集（SSE 全程流式渲染）。
 * @param {string} name 游戏名
 * @returns {Promise<void>}
 */
async function runCollect(name) {
  running = true;
  collectBtn.disabled = true;
  collectBtn.textContent = "搜集中…";
  resetPanels();
  enableTab("running");
  setState("running");
  addLog("info", "开始搜集：" + name);

  try {
    const r = await fetch("/api/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name,
        forceTrailer: forceTrailerCb.checked,
        forceCover: forceCoverCb.checked,
        coverUrl: coverUrlInput.value.trim(),
      }),
    });
    const ctype = r.headers.get("content-type") || "";
    if (!r.ok && ctype.indexOf("application/json") >= 0) {
      const d = await r.json();
      addLog("err", d.error || ("HTTP " + r.status));
      formError.textContent = d.error || ("请求失败：HTTP " + r.status);
      doneSummary.className = "result-summary fail";
      doneSummary.innerHTML = summaryIcon("fail") + " " + esc("执行失败：" + (d.error || r.status));
      enableTab("done");
      return;
    }
    if (!r.body) {
      addLog("err", "服务端未返回流式响应");
      return;
    }

    // 解析 SSE 流：每条 `data: <JSON>` 以空行分隔；`: hb` 心跳行自动被忽略
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev = null;
        try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
        handleEvent(ev);
      }
    }
  } catch (e) {
    addLog("err", "请求失败：" + e.message);
    formError.textContent = "请求失败：" + e.message;
    doneSummary.className = "result-summary fail";
    doneSummary.innerHTML = summaryIcon("fail") + " " + esc("执行异常：" + e.message);
    enableTab("done");
  } finally {
    running = false;
    collectBtn.disabled = false;
    collectBtn.textContent = "开始搜集";
    forceTrailerCb.checked = false;
    forceCoverCb.checked = false;
    coverUrlInput.value = "";
  }
}

/**
 * 处理单条 SSE 事件。
 * @param {object} ev {type, step, msg, ok, detail?}
 */
function handleEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  const type = String(ev.type || "");

  if (type === "log") {
    const lvl = (ev.detail && ev.detail.level) || "info";
    addLog(lvl === "err" ? "err" : lvl === "ok" ? "ok" : "info", ev.msg || "");
    return;
  }

  if (type === "done") {
    addLog(ev.ok === true ? "ok" : "err", (ev.step || "完成") + " — " + (ev.msg || ""));
    renderDone(ev);
    enableTab("done");
    setState("done");
    return;
  }

  if (type === "error") {
    const group = (ev.detail && ev.detail.group) || GROUP_OF_TYPE[type] || "flow";
    addLog("err", "[" + group + "] " + (ev.msg || ""));
    if (ev.detail && ev.detail.guidance) addLog("info", "安装引导：" + ev.detail.guidance);
    applyStep(group, ev);
    return;
  }

  const group = GROUP_OF_TYPE[type];
  if (!group) return;
  addLog(ev.ok === true ? "ok" : "info", "[" + group + "] " + (ev.msg || ""));
  applyStep(group, ev);
}

// ── 事件绑定 ──
collectBtn.onclick = () => {
  if (running) return;
  const name = gameName.value.trim();
  if (!name) {
    formError.textContent = "请先输入游戏名";
    gameName.focus();
    return;
  }
  formError.textContent = "";
  runCollect(name);
};

gameName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") collectBtn.click();
});

// 状态 tab 仅做「查看」切换，不影响执行（未就绪的 tab 处于 disabled）
stateTabs.querySelectorAll("button").forEach((btn) => {
  btn.onclick = () => {
    if (btn.disabled) return;
    setState(btn.dataset.state);
  };
});

// 页头版本号（与 /api/version 契约一致，仅展示用）
fetch("/api/version")
  .then((r) => r.json())
  .then((d) => { verText.textContent = "v" + (d && d.version ? d.version : "—"); })
  .catch(() => { verText.textContent = ""; });
