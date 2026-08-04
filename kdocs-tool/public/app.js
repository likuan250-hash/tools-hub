const $ = id => document.getElementById(id);
const gameInput = $("gameInput"), coverUrl = $("coverUrl");
const autoBtn = $("autoBtn"), coverDir = $("coverDir"), browseDirBtn = $("browseDirBtn");
const clearBtn = $("clearBtn");
const preview = $("preview"), previewContent = $("previewContent");
const autoResult = $("autoResult"), autoSteps = $("autoSteps"), autoSummary = $("autoSummary"), autoLog = $("autoLog"), kdocsViewBtn = $("kdocsViewBtn");
const retryCoverBtn = $("retryCoverBtn");
const chipKdocs = $("chipKdocs"), kdocsBtn = $("kdocsBtn"), toastHost = $("toastHost");

// ── 分类标签选择（P0 用户偏好：免安装硬盘版/PC游戏/全DLC 三个默认勾上）──
// 与金山文档「游戏信息」多选字段对齐：用户点 pill 切换 on/off；当前选中的标签会在「解析预览」里也显示。
// 后端会写入 dbsheet 的「游戏信息」字段，免去用户在金文档端每次手动勾选。
const CLASSIFICATION_TAGS = ["免安装硬盘版", "PC游戏", "全DLC", "虚拟机版", "查询工具", "游戏工具", "热门推荐", "最近更新"];
const classTagToggles = $("classTagToggles");
const classTagPills = classTagToggles ? Array.from(classTagToggles.querySelectorAll(".tag-pill")) : [];
const DEFAULT_CHECKED = new Set(["免安装硬盘版", "PC游戏", "全DLC"]); // 与后端 DEFAULT_CLASSIFICATION_TAGS 保持一致
function getSelectedClassificationTags() {
  return classTagPills.filter(p => p.classList.contains("on")).map(p => p.dataset.tag);
}
classTagPills.forEach(pill => {
  if (DEFAULT_CHECKED.has(pill.dataset.tag)) pill.classList.add("on");
  pill.addEventListener("click", () => {
    pill.classList.toggle("on");
    // 标签变更后重渲染预览（如果预览已显示）
    if (preview.style.display === "block" && gameInput.value.trim()) doPreview();
  });
});

// ── 统一执行按钮 loading 切换（macOS 线性图标风格：执行中显示 spinner + 执行中…）──
function setExec(btn, on) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.label === undefined) {
      var l = btn.querySelector('.bx-label');
      btn.dataset.label = l ? l.textContent : btn.textContent;
    }
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    var lbl = btn.querySelector('.bx-label');
    if (lbl) lbl.textContent = '执行中…';
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    var lbl2 = btn.querySelector('.bx-label');
    if (lbl2 && btn.dataset.label !== undefined) lbl2.textContent = btn.dataset.label;
  }
}

let currentParsed = null;
let currentRecordId = null;   // 供「仅重传封面」补传
let currentCoverPath = null;  // 已下载但上传失败的本地封面路径

// ── 「仅重传封面」：封面已下载但上传失败时，补传并写回记录（P0-3 补救）──
retryCoverBtn.onclick = async () => {
  if (!currentRecordId || !currentCoverPath) return;
  retryCoverBtn.disabled = true;
  retryCoverBtn.innerHTML = ico("hourglass") + " 重传中…";
  try {
    const r = await fetch("/api/retry-cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordId: currentRecordId, coverPath: currentCoverPath }),
    });
    const d = await r.json();
    if (d.success) {
      autoSummary.className = "result-summary ok";
      autoSummary.textContent = "封面已补传，记录完整";
      addLog("ok", "封面已重新上传并写入记录");
      retryCoverBtn.style.display = "none";
    } else {
      autoSummary.className = "result-summary fail";
      autoSummary.textContent = "封面重传仍失败：" + (d.error || "未知");
      addLog("err", "封面重传失败：" + (d.error || ""));
      retryCoverBtn.disabled = false;
      retryCoverBtn.innerHTML = ico("refresh") + " 仅重传封面";
    }
  } catch (e) {
    autoSummary.className = "result-summary fail";
      autoSummary.textContent = "重传请求失败：" + e.message;
      addLog("err", "重传请求失败：" + e.message);
    retryCoverBtn.disabled = false;
    retryCoverBtn.innerHTML = ico("refresh") + " 仅重传封面";
  }
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

// ── Toast（与 biliup/netdisk 统一：玻璃 .toast-host + 子节点，3s 自动消失，复用 pop-in 入场）──
function toastMsg(msg, type) {
  let host = toastHost;
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  const isErr = type === "err";
  const el = document.createElement("div");
  el.className = "toast pop-in";
  el.setAttribute("role", "status");
  el.innerHTML = '<span class="toast-ico"></span><span class="toast-msg"></span>';
  el.querySelector(".toast-ico").innerHTML = isErr ? ico("cross") : ico("check");
  el.querySelector(".toast-msg").textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }, 3000);
}

function setChip(el, ok, label) {
  el.innerHTML = statusHTML(ok ? "ok" : "off", label);
}

// ── 启动检查 ──
async function initCheck() {
  try {
    const r = await fetch("/api/check");
    const d = await r.json();
    setChip(chipKdocs, d.kdocsReady, d.kdocsReady ? "kdocs 已配置" : "kdocs 未配置");
  } catch {
    setChip(chipKdocs, false, "后端未连接");
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
  // 分类标签 = 自动检测的 parsed.tags + 用户当前勾选的分类标签（去重保序）
  const seen = new Set();
  const allTags = [];
  const push = (t) => { if (t && !seen.has(t)) { seen.add(t); allTags.push(t); } };
  getSelectedClassificationTags().forEach(push);
  (p.tags || []).forEach(push);
  const th = allTags.map(t => `<span class="tag">${esc(t)}</span>`).join(" ");
  const rows = [
    `<span class="label">${ico('gamepad')} 游戏</span><span class="value">${esc(p.gameName)}${p.englishName ? "（" + esc(p.englishName) + "）" : ""}</span>`,
    `<span class="label">${ico('tag')} 标签</span><span class="value">${th}</span>`,
    p.coverUrl ? `<span class="label">${ico('image')} 封面</span><span class="value">${esc(p.coverUrl)}</span>` : "",
    p.baiduUrl ? `<span class="label">${ico('link')} 百度</span><span class="value">${esc(p.baiduUrl)}</span>` : "",
    p.quarkUrl ? `<span class="label">${ico('link')} 夸克</span><span class="value">${esc(p.quarkUrl)}</span>` : "",
    p.xunleiUrl ? `<span class="label">${ico('link')} 迅雷</span><span class="value">${esc(p.xunleiUrl)}</span>` : "",
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
  const icon = s.status === "成功" ? ico("check") : s.status === "跳过" ? ico("skip") : s.status === "失败" ? ico("cross") : s.status === "警告" ? ico("warning") : ico("refresh");
  const detail = buildStepDetail(s);
  // 状态 → 等级映射（玻璃胶囊三重编码）
  const LEVEL = { "进行中": "info", "成功": "ok", "失败": "err", "跳过": "off", "警告": "warn" };
  const lvl = LEVEL[s.status] || "info";
  const label = esc(s.name) + " — " + s.status;
  let item = stepEls[s.index];
  if (!item) {
    item = document.createElement("div");
    item.className = "step-item";
    autoSteps.appendChild(item);
    stepEls[s.index] = item;
  }
  item.innerHTML = '<span class="step-icon">' + icon + '</span><div class="step-body"><div class="step-name">' + statusHTML(lvl, label) + "</div>" + (detail ? '<div class="step-detail">' + detail + "</div>" : "") + "</div>";
  // 进行中的步骤高亮提示，完成后取消
  if (s.status === "进行中") {
    addLog("info", "进行中：" + s.name);
  } else {
    addLog(s.status === "成功" ? "ok" : s.status === "失败" ? "err" : "info", s.name + " — " + s.status);
  }
}

// ── P09：统一弹窗机制（openModal/closeModal，来去一致、回到原页、不丢上下文）──
let activeModal = null;
function openModal(modalEl) {
  if (!modalEl) return;
  activeModal = modalEl; // 记录当前浮层，关闭即回到下层原页（不切路由、不重置表单）
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
const HISTORY_KEY_KDOCS = "toolshub:history:kdocs";
const HISTORY_MAX = 50;
function loadHistory(key) {
  try { return JSON.parse(localStorage.getItem(key) || "[]") || []; } catch { return []; }
}
function pushHistory(key, entry) {
  const list = loadHistory(key);
  list.unshift(entry); // 最新在前
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* 隐私模式可能抛错，忽略 */ }
  return list;
}
function writeKdocsHistory(ok, title, status) {
  pushHistory(HISTORY_KEY_KDOCS, { ts: Date.now(), ok: !!ok, title: title || "（未命名）", status: status || "" });
}

// ── 重复确认 modal 元素与互斥逻辑（接入 P09 统一弹窗）──
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
  openModal(dupMask);
}

dupCancel.onclick = () => { closeModal(); addLog("info", "已取消（保留原记录）"); };
dupContinue.onclick = () => {
  closeModal();
  runAuto(_dupText, { forceAdd: chkForceAdd.checked, updateLinks: chkUpdateLinks.checked });
};

// ── 一键执行（SSE 流式进度，实时看到每一步）──
// 真正执行（可选 forceAdd / updateLinks）
async function runAuto(text, opts = {}) {
  setExec(autoBtn, true);
  autoResult.classList.remove("show");
  autoSteps.innerHTML = "";
  autoLog.innerHTML = "";
  autoSummary.textContent = "";
  kdocsViewBtn.style.display = "none";
  retryCoverBtn.style.display = "none";
  retryCoverBtn.disabled = false;
  retryCoverBtn.innerHTML = ico("refresh") + " 仅重传封面";
  stepEls.length = 0;

  autoResult.classList.add("show");
  addLog("info", "开始一键执行..." + (opts.forceAdd ? "（强制新增）" : opts.updateLinks ? "（更新网盘链接）" : ""));

  try {
    const r = await fetch("/api/auto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, coverDir: coverDir.value.trim() || undefined, manualCoverUrl: coverUrl.value.trim(), forceAdd: !!opts.forceAdd, updateLinks: !!opts.updateLinks, classificationTags: getSelectedClassificationTags() }),
    });
    if (!r.ok && r.headers.get("content-type")?.includes("application/json")) {
      const d = await r.json();
      addLog("err", (d.error || r.status));
      autoSummary.className = "result-summary fail";
      autoSummary.textContent = "执行失败";
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
          addLog("err", ev.error);
          autoSummary.className = "result-summary fail";
          autoSummary.textContent = "执行异常";
        } else if (ev.type === "done") {
          finished = true;
          const d = ev.result;
          currentRecordId = d.recordId || null;
          currentCoverPath = d.coverPath || null;
          retryCoverBtn.style.display = "none"; // 默认隐藏，封面缺失且可补传时才显示
          if (d.gameName) { currentParsed = { ...currentParsed, gameName: d.gameName }; preview.style.display = "block"; }
          if (!d.success) {
            autoSummary.className = "result-summary fail";
            autoSummary.textContent = "部分步骤未成功";
            retryCoverBtn.style.display = (d.coverLost && d.coverPath) ? "block" : "none";
          } else if (d.coverStatus === "failed") {
            // 封面缺失但记录已建：显式黄警，不再假装「全部完成」（P0-1 修复）
            autoSummary.className = "result-summary warn";
            autoSummary.textContent = "已完成，但封面未成功获取/上传（记录无封面）";
            addLog("info", "封面缺失：" + (d.coverLost ? "已下载但上传失败，可点「仅重传封面」" : "下载失败，无可用封面"));
            retryCoverBtn.style.display = (d.coverLost && d.coverPath) ? "block" : "none";
          } else if (d.action === "skipped") {
            autoSummary.className = "result-summary ok";
            autoSummary.textContent = "已跳过（文档中已存在）记录 ID: " + (d.recordId || "—");
            addLog("ok", "已跳过，文档中已存在该游戏（记录 " + (d.recordId || "") + "）");
          } else if (d.action === "updated") {
            autoSummary.className = "result-summary ok";
            autoSummary.textContent = "已更新网盘链接 记录 ID: " + (d.recordId || "—");
            addLog("ok", "记录 " + (d.recordId || "") + " 网盘链接已更新");
          } else {
            autoSummary.className = "result-summary ok";
            autoSummary.textContent = "全部完成！记录 ID: " + (d.recordId || "—");
            addLog("ok", d.recordId ? "记录 " + d.recordId + " 创建成功！" : "全部完成！");
          }
          // 数据溯源：介绍/大小来源（provenance）让正确性可追溯
          const prov = [];
          if (d.introProvenance) prov.push("介绍:" + d.introProvenance);
          if (d.sizeProvenance) prov.push("大小:" + d.sizeProvenance);
          if (prov.length) addLog("info", "数据溯源 — " + prov.join(" · "));
          // 占位/缺失字段显式标注（不再静默空），提醒人工校对
          if (d.needsReview) {
            autoSummary.className = "result-summary warn";
            autoSummary.textContent = "已完成，但部分字段为占位/待核对（" + prov.join("，") + "），建议人工补充";
            addLog("info", "需人工校对：介绍或大小来源不可靠，已占位标注，建议后续补充真实数据");
          }

          // 有记录即可查看（创建/更新/跳过/封面缺失均视为有记录可查；整体失败时若已建记录也允许查看）
          kdocsViewBtn.style.display = d.recordId ? "block" : "none";

          // P08：写一条录入历史（成功/失败 + 稿件标题 + 时间 + 简要状态）
          {
            const p = parseInput(text);
            const title = d.gameName || (p && p.gameName) || (currentParsed && currentParsed.gameName) || "（未命名）";
            let ok = true, status = "成功";
            if (!d.success) { ok = false; status = "部分步骤失败"; }
            else if (d.coverStatus === "failed") { ok = true; status = "完成(封面缺失)"; }
            else if (d.action === "skipped") { ok = true; status = "已跳过"; }
            else if (d.action === "updated") { ok = true; status = "已更新链接"; }
            writeKdocsHistory(ok, title, status);
          }
        }
      }
    }
  } catch (e) {
    const p = parseInput(text);
    const title = (p && p.gameName) || (currentParsed && currentParsed.gameName) || "（未命名）";
    writeKdocsHistory(false, title, "请求异常");
    addLog("err", "请求失败: " + e.message);
    autoSummary.className = "result-summary fail";
    autoSummary.textContent = "执行异常";
  } finally {
    setExec(autoBtn, false);
  }
}

autoBtn.onclick = async () => {
  const text = gameInput.value.trim();
  if (!text) { toastMsg("请先粘贴游戏信息", "err"); return; }
  // 执行前先查重，命中重复则弹确认框（统一走 setExec，不再直接写 textContent 以免破坏 macOS 线性图标结构）
  setExec(autoBtn, true);
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
    setExec(autoBtn, false);
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

// 状态胶囊光标光斑（info 态 hover 随动）
if (typeof bindStatusCursor === "function") bindStatusCursor(document);

// ── P08：历史展示（接入 P09 统一弹窗机制）──
const historyMask = $("historyMask"), historyList = $("historyList");
const historyOpenBtn = $("historyIconBtn"), historyCloseBtn = $("historyClose"), historyClearBtn = $("historyClear");

function renderKdocsHistory() {
  const list = loadHistory(HISTORY_KEY_KDOCS);
  if (!list.length) { historyList.innerHTML = '<div class="empty-state"><span class="es-ico">' + ico('inbox') + '</span>还没有录入记录</div>'; return; }
  historyList.innerHTML = list.map((h) => {
    const time = new Date(h.ts).toLocaleString("zh-CN");
    const badge = h.ok ? "成功" : "失败";
    return `<div class="history-item">
      <span class="history-dot ${h.ok ? "ok" : "err"}"></span>
      <div class="history-main">
        <div class="history-title">${esc(h.title)}</div>
        <div class="history-meta">${esc(badge + (h.status ? " · " + h.status : ""))} · ${esc(time)}</div>
      </div>
    </div>`;
  }).join("");
}
function openKdocsHistory() {
  renderKdocsHistory();
  openModal(historyMask);
}
if (historyOpenBtn) historyOpenBtn.onclick = openKdocsHistory;
if (historyCloseBtn) historyCloseBtn.onclick = closeModal;
if (historyMask) historyMask.addEventListener("click", (e) => { if (e.target === historyMask) closeModal(); });
if (historyClearBtn) historyClearBtn.onclick = () => {
  if (confirm("确定清空全部录入历史?")) {
    try { localStorage.removeItem(HISTORY_KEY_KDOCS); } catch { /* ignore */ }
    renderKdocsHistory();
  }
};

// T02：首屏入场编排（零侵入：仅给 .wrap 首屏可见块挂 pop-in + --i，复用内联 macos-motion.css 的 stagger）
(function () {
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
