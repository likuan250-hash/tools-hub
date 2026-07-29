const $ = id => document.getElementById(id);
const gameInput = $("gameInput"), coverUrl = $("coverUrl");
const autoBtn = $("autoBtn"), coverDir = $("coverDir"), browseDirBtn = $("browseDirBtn");
const clearBtn = $("clearBtn");
const preview = $("preview"), previewContent = $("previewContent");
const autoResult = $("autoResult"), autoSteps = $("autoSteps"), autoSummary = $("autoSummary"), autoLog = $("autoLog"), kdocsViewBtn = $("kdocsViewBtn");
const toast = $("toast"), chipKdocs = $("chipKdocs"), chipBl = $("chipBl"), kdocsBtn = $("kdocsBtn");

let currentParsed = null;

// ── 主题切换（与网盘转存中转台统一，持久化到 localStorage）──
const themeBtn = $("themeBtn");
const savedTheme = localStorage.getItem("theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);
themeBtn.onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
};

// ── 金山文档入口：顶栏常驻 + 成功后「在金山文档查看」，系统浏览器打开多维表 ──
const KDOCS_VIEW_URL = "https://www.kdocs.cn/l/h9aREMoyL1MMMeDCHLWa1xsikoTpExj2o"; // 与 lib/config.js FILE_ID 对应
function openKdocsView() {
  const url = KDOCS_VIEW_URL;
  if (window.electronAPI && typeof window.electronAPI.openExternal === "function") {
    window.electronAPI.openExternal(url); // 桌面壳内：用系统默认浏览器打开
  } else {
    window.open(url, "_blank"); // 独立运行时：新标签打开
  }
}
kdocsBtn.onclick = openKdocsView;
kdocsViewBtn.onclick = openKdocsView;

// ── Toast ──
function toastMsg(msg, type) {
  toast.textContent = msg;
  toast.style.background = type === "err" ? "var(--err)" : "var(--ok)";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function setChip(el, ok, label) {
  el.innerHTML = `<span class="dot ${ok ? "green" : "red"}"></span> ${label}`;
}

// ── 启动检查 ──
async function initCheck() {
  try {
    const r = await fetch("/api/check");
    const d = await r.json();
    setChip(chipKdocs, d.kdocsReady, d.kdocsReady ? "kdocs ✅ 已配置" : "kdocs ⚠️ 未配置");
    setChip(chipBl, d.blAvailable, d.blAvailable ? "AI ✅ 可用" : "AI ⚠️ 不可用");
  } catch {
    setChip(chipKdocs, false, "后端未连接");
    setChip(chipBl, false, "后端未连接");
  }
}
initCheck();

// ── 清空（输入框右上角）──
clearBtn.onclick = () => {
  gameInput.value = "";
  coverUrl.value = "";
  preview.style.display = "none";
  autoResult.classList.remove("show");
  currentParsed = null;
};

// ── 封面目录选择（打开系统文件夹选择器，回填绝对路径）──
browseDirBtn.onclick = async () => {
  browseDirBtn.disabled = true;
  const oldText = browseDirBtn.textContent;
  browseDirBtn.textContent = "选择中…";
  try {
    // 优先走 Electron 原生对话框（在 tools-hub 桌面应用内运行时可用）
    if (window.electronAPI && window.electronAPI.pickFolder) {
      const d = await window.electronAPI.pickFolder();
      if (d && d.dir) coverDir.value = d.dir;
      // cancelled 或空：保持原值
    } else {
      // 回退：独立运行时走后端 /api/browse-dir（由 Tkinter 控制面板弹窗）
      const r = await fetch("/api/browse-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initial: coverDir.value.trim() || "" }),
      });
      const d = await r.json();
      if (d.dir) {
        coverDir.value = d.dir;
      } else if (d.cancelled) {
        /* 用户取消，保持原值 */
      } else {
        toastMsg("打开文件夹选择器失败：" + (d.error || "未知错误"), "err");
      }
    }
  } catch (e) {
    toastMsg("无法打开文件夹选择器：" + e.message, "err");
  } finally {
    browseDirBtn.disabled = false;
    browseDirBtn.textContent = oldText;
  }
};

// ── 预览 ──
let pt;
gameInput.oninput = () => { clearTimeout(pt); pt = setTimeout(doPreview, 400); };

function doPreview() {
  const t = gameInput.value.trim();
  if (!t) { preview.style.display = "none"; return; }
  const p = parseInput(t);
  if (!p) { preview.style.display = "none"; return; }
  preview.style.display = "block";
  renderPreview(p);
}

// 与后端 parser.js 保持一致的轻量解析（仅用于前端预览）
function parseInput(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l);
  if (!lines.length) return null;
  const first = lines[0];
  let b = "", q = "", x = "";
  for (const l of lines) {
    const c = l.replace(/^(?:链接)?[：:]\s*/, "");
    if (c.includes("pan.baidu.com")) b = c;
    else if (c.includes("pan.quark.cn")) q = c;
    else if (c.includes("pan.xunlei.com")) x = c;
  }
  let name = first, en = "";
  const m = first.match(/[（(]([^）)]+)[）)]/);
  if (m) { en = m[1]; name = first.substring(0, m.index).trim() || en; }
  const tags = [];
  if (first.includes("全DLC")) tags.push("全DLC");
  if (first.includes("免安装硬盘版") || first.includes("免安装")) tags.push("免安装硬盘版");
  if (first.includes("虚拟机版") || first.includes("虚拟机")) tags.push("虚拟机版");
  if (first.includes("联机") || first.includes("合作")) tags.push("联机合作");
  if (!tags.includes("虚拟机版")) tags.unshift("PC游戏");

  let cover = "";
  for (const line of lines) {
    const cm = line.match(/(?:封面|cover)?\s*[:：]?\s*(https?:\/\/\S+\.(?:jpg|jpeg|png|webp|gif))(?:\?[^)\s]*)?/i);
    if (cm) { cover = cm[1]; break; }
  }
  return { gameName: name, englishName: en, baiduUrl: b, quarkUrl: q, xunleiUrl: x, tags, raw: first, coverUrl: cover };
}

function renderPreview(p) {
  const th = p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join(" ");
  const rows = [
    `<span class="label">🎮 游戏</span><span class="value">${esc(p.gameName)}${p.englishName ? "（" + esc(p.englishName) + "）" : ""}</span>`,
    `<span class="label">🏷️ 标签</span><span class="value">${th}</span>`,
    p.coverUrl ? `<span class="label">🖼️ 封面</span><span class="value">${esc(p.coverUrl)}</span>` : "",
    p.baiduUrl ? `<span class="label">🔗 百度</span><span class="value">${esc(p.baiduUrl)}</span>` : "",
    p.quarkUrl ? `<span class="label">🔗 夸克</span><span class="value">${esc(p.quarkUrl)}</span>` : "",
    p.xunleiUrl ? `<span class="label">🔗 迅雷</span><span class="value">${esc(p.xunleiUrl)}</span>` : "",
  ];
  previewContent.innerHTML = rows.join("");
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ── 一键执行（SSE 流式进度，实时看到每一步）──
const stepEls = []; // 按 index 缓存已渲染的步骤节点，便于「进行中→成功」原地更新

function buildStepDetail(s) {
  const detailParts = [];
  if (s.appid) detailParts.push("AppID: " + s.appid);
  if (s.path) detailParts.push("路径: " + s.path);
  if (s.size) detailParts.push(s.size);
  if (s.files) detailParts.push("文件数: " + s.files);
  if (s.objectId) detailParts.push("ObjectID: " + s.objectId);
  if (s.recordId) detailParts.push("记录ID: " + s.recordId);
  if (s.desc) detailParts.push("摘要: " + s.desc.slice(0, 60) + (s.desc.length > 60 ? "…" : ""));
  if (s.reason) detailParts.push('<span class="err">' + esc(s.reason) + "</span>");
  if (s.error) detailParts.push('<span class="err">' + esc(s.error) + "</span>");
  return detailParts.join(" · ");
}

function renderStep(s) {
  const icon = s.status === "成功" ? "✅" : s.status === "跳过" ? "⏭️" : s.status === "失败" ? "❌" : "🔄";
  const detail = buildStepDetail(s);
  let item = stepEls[s.index];
  if (!item) {
    item = document.createElement("div");
    item.className = "step-item";
    autoSteps.appendChild(item);
    stepEls[s.index] = item;
  }
  item.innerHTML = '<span class="step-icon">' + icon + '</span><div class="step-body"><div class="step-name">' + esc(s.name) + " — " + s.status + "</div>" + (detail ? '<div class="step-detail">' + detail + "</div>" : "") + "</div>";
  // 进行中的步骤高亮提示，完成后取消
  if (s.status === "进行中") {
    addLog("info", "🔄 进行中：" + s.name);
  } else {
    addLog(s.status === "成功" ? "ok" : s.status === "失败" ? "err" : "info", icon + " " + s.name + " — " + s.status);
  }
}

// ── 重复确认 modal 元素与互斥逻辑 ──
const dupMask = $("dupMask"), dupTitle = $("dupTitle"), dupBody = $("dupBody");
const chkForceAdd = $("chkForceAdd"), chkUpdateLinks = $("chkUpdateLinks");
const dupCancel = $("dupCancel"), dupContinue = $("dupContinue");

// 两选项互斥（勾一个禁用另一个）
chkForceAdd.onchange = () => { if (chkForceAdd.checked) chkUpdateLinks.checked = false; };
chkUpdateLinks.onchange = () => { if (chkUpdateLinks.checked) chkForceAdd.checked = false; };

let _dupText = "";
function showDupModal(text, d) {
  _dupText = text;
  const p = parseInput(text);
  dupTitle.textContent = `《${p ? p.gameName : "该游戏"}》已存在于文档中`;
  const links = [];
  if (d.existingLinks && d.existingLinks.baidu) links.push("百度");
  if (d.existingLinks && d.existingLinks.quark) links.push("夸克");
  if (d.existingLinks && d.existingLinks.xunlei) links.push("迅雷");
  dupBody.innerHTML = `记录 ID：<b>${esc(d.recordId || "")}</b><br>当前已有网盘链接：${links.length ? links.map(l => `<span class="lk">${esc(l)}</span>`).join("") : "（无）"}<br>请选择处理方式（默认跳过）：`;
  chkForceAdd.checked = false; chkUpdateLinks.checked = false;
  dupMask.style.display = "grid";
}

dupCancel.onclick = () => { dupMask.style.display = "none"; addLog("info", "🚫 已取消（保留原记录）"); };
dupContinue.onclick = () => {
  dupMask.style.display = "none";
  runAuto(_dupText, { forceAdd: chkForceAdd.checked, updateLinks: chkUpdateLinks.checked });
};

// ── 一键执行（SSE 流式进度，实时看到每一步）──
// 真正执行（可选 forceAdd / updateLinks）
async function runAuto(text, opts = {}) {
  autoBtn.disabled = true;
  autoBtn.textContent = "⏳ 执行中...";
  autoResult.classList.remove("show");
  autoSteps.innerHTML = "";
  autoLog.innerHTML = "";
  autoSummary.textContent = "";
  kdocsViewBtn.style.display = "none";
  stepEls.length = 0;

  autoResult.classList.add("show");
  addLog("info", "🚀 开始一键执行..." + (opts.forceAdd ? "（强制新增）" : opts.updateLinks ? "（更新网盘链接）" : ""));

  try {
    const r = await fetch("/api/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, coverDir: coverDir.value.trim() || undefined, manualCoverUrl: coverUrl.value.trim(), forceAdd: !!opts.forceAdd, updateLinks: !!opts.updateLinks }),
    });
    if (!r.ok && r.headers.get("content-type")?.includes("application/json")) {
      const d = await r.json();
      addLog("err", "❌ " + (d.error || r.status));
      autoSummary.className = "result-summary fail";
      autoSummary.textContent = "❌ 执行失败";
      return;
    }

    // 解析 SSE 流：每条 data: 是一个 JSON 事件
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = chunk.split("\n").find(l => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === "step") {
          renderStep(ev.step);
        } else if (ev.type === "error") {
          addLog("err", "❌ " + ev.error);
          autoSummary.className = "result-summary fail";
          autoSummary.textContent = "❌ 执行异常";
        } else if (ev.type === "done") {
          finished = true;
          const d = ev.result;
          if (d.gameName) { currentParsed = { ...currentParsed, gameName: d.gameName }; preview.style.display = "block"; }
          if (!d.success) {
            autoSummary.className = "result-summary fail";
            autoSummary.textContent = "⚠️ 部分步骤未成功";
          } else if (d.action === "skipped") {
            autoSummary.className = "result-summary ok";
            autoSummary.textContent = "⏭️ 已跳过（文档中已存在）记录 ID: " + (d.recordId || "—");
            addLog("ok", "⏭️ 已跳过，文档中已存在该游戏（记录 " + (d.recordId || "") + "）");
          } else if (d.action === "updated") {
            autoSummary.className = "result-summary ok";
            autoSummary.textContent = "✅ 已更新网盘链接 记录 ID: " + (d.recordId || "—");
            addLog("ok", "🔗 记录 " + (d.recordId || "") + " 网盘链接已更新");
          } else {
            autoSummary.className = "result-summary ok";
            autoSummary.textContent = "✅ 全部完成！记录 ID: " + (d.recordId || "—");
            addLog("ok", d.recordId ? "🎉 记录 " + d.recordId + " 创建成功！" : "🎉 全部完成！");
          }
          // 成功后显示「在金山文档查看」按钮（创建/更新/跳过均视为有记录可查）
          kdocsViewBtn.style.display = d.success ? "block" : "none";
        }
      }
    }
  } catch (e) {
    addLog("err", "❌ 请求失败: " + e.message);
    autoSummary.className = "result-summary fail";
    autoSummary.textContent = "❌ 执行异常";
  } finally {
    autoBtn.disabled = false;
    autoBtn.textContent = "🤖 一键执行";
  }
}

autoBtn.onclick = async () => {
  const text = gameInput.value.trim();
  if (!text) { toastMsg("请先粘贴游戏信息", "err"); return; }
  // 执行前先查重，命中重复则弹确认框
  autoBtn.disabled = true;
  autoBtn.textContent = "🔍 查重中...";
  try {
    const r = await fetch("/api/check-exists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.exists) { showDupModal(text, d); return; }
    }
  } catch { /* 查重接口异常不阻断，直接执行 */ }
  finally {
    autoBtn.disabled = false;
    autoBtn.textContent = "🤖 一键执行";
  }
  runAuto(text);
};

function addLog(type, msg) {
  const div = document.createElement("div");
  div.className = "line " + type;
  div.textContent = msg;
  autoLog.appendChild(div);
  autoLog.scrollTop = autoLog.scrollHeight;
}

// ── 右上角版本徽章 / 检测更新 ──
const verBadge = $("verBadge");
let _checking = false, _hasUpdate = false, _remoteVer = "";

function badgeState(state, text) {
  verBadge.classList.remove("checking", "has-update", "latest");
  if (state) verBadge.classList.add(state);
  verBadge.textContent = text;
}

async function loadVersion() {
  try {
    const r = await fetch("/api/version");
    const d = await r.json();
    verBadge.textContent = "v" + d.version;
    verBadge.title = "点击检查更新" + (d.commit ? " (" + d.commit + ")" : "");
  } catch { verBadge.textContent = "v?"; }
}

async function doUpdate() {
  badgeState("checking", "更新中…");
  try {
    const r = await fetch("/api/update", { method: "POST" });
    const d = await r.json();
    if (!d.ok) {
      badgeState(_hasUpdate ? "has-update" : null, _hasUpdate ? "⬆ v" + _remoteVer : "v?");
      toastMsg("更新失败: " + (d.error || ""), "err");
      return;
    }
    if (!d.updated) {
      badgeState("latest", "✓ 已最新");
      verBadge.title = "已是最新版本";
      setTimeout(loadVersion, 1500);
      return;
    }
    if (d.needsNpmInstall) {
      badgeState("has-update", "⬆ 需重启");
      toastMsg("代码已更新（含依赖变更），请通过「控制面板」点击「重启」生效", "err");
      return;
    }
    toastMsg("✅ 已更新，正在重启…");
    setTimeout(async () => {
      try { await fetch("/api/restart", { method: "POST" }); } catch { /* 旧进程即将退出 */ }
      setTimeout(() => location.reload(), 2600);
    }, 800);
  } catch (e) {
    badgeState(_hasUpdate ? "has-update" : null, _hasUpdate ? "⬆ v" + _remoteVer : "v?");
    toastMsg("更新失败: " + e.message, "err");
  }
}

verBadge.onclick = async () => {
  if (_checking) return;
  if (_hasUpdate) {
    if (!confirm("确定更新到最新版本并重启服务?")) return;
    await doUpdate();
    return;
  }
  _checking = true;
  badgeState("checking", "检测中…");
  try {
    const r = await fetch("/api/check-update");
    const d = await r.json();
    if (!d.ok) {
      badgeState(null, "检测失败");
      toastMsg("检测失败: " + (d.error || ""), "err");
      setTimeout(loadVersion, 1500);
      return;
    }
    if (d.hasUpdate) {
      _hasUpdate = true; _remoteVer = d.remoteCommit;
      badgeState("has-update", "⬆ " + d.remoteCommit);
      verBadge.title = "发现新版本 " + d.remoteCommit + "，点击更新";
      toastMsg("🔔 发现新版本，点击徽章更新");
    } else {
      badgeState("latest", "✓ 已最新");
      verBadge.title = "已是最新版本";
      setTimeout(loadVersion, 1800);
    }
  } catch (e) {
    badgeState(null, "检测失败");
    setTimeout(loadVersion, 1500);
  } finally {
    _checking = false;
  }
};

loadVersion();
