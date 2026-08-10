// biliup-hub/public/app.js —— 前端逻辑
// pickFile 选视频 / 参数读写 / 发布模式 + 二次确认 / 消费 /api/upload SSE /
// 状态胶囊(#1) / 投稿日志默认隐藏(#4) / 账号头像+扫码登录(#7) / 健康探活(#5)。
/* global ico, selectPreserve, coerceInt */
(function () {
  "use strict";
  const api = window.electronAPI;
  const $ = (id) => document.getElementById(id);

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

  // ── 标签自动生成（#②：选入视频/标题变化时基于文件名或标题提取，叠加默认标签兜底）──
  // 纯函数：取文件名(去扩展名)或标题 → 分词 → 去停用词/短词 → 叠加默认标签 → 去重 → 限长。
  // 自包含（停用词内联），便于单测独立抽取；不依赖模块作用域变量。
  function genTags(fileName, title, defaultTags) {
    // 停用词：中文虚词/泛化词/格式后缀 + 游戏分享场景常见"版本描述词"（纯版本描述、非内容关键词，防进 B 站标签）。
    // 版本/冗余描述词（全DLC/DLC/官方/Gameplay 等）一并过滤：作为 B 站标签既无检索价值也显得潦草（需求②/C）。
    const STOP_WORDS = new Set([
      '的', '了', '是', '在', '和', '与', '及', '也', '都', '就', '而', '吗', '呢', '啊',
      '吧', '哦', '啦', '嘛', '我们', '你们', '他们', '我', '你', '他', '她', '它', '这',
      '那', '这个', '那个', '视频', '投稿', '高清', '完整', '版', 'hd', 'video', 'mp4',
      'mkv', 'avi', 'flv', 'mov', 'webm', 'bilibili', 'b站', 'the', 'a', 'an', 'of', 'to',
      'and', 'or', 'on', 'in', 'at', 'by', 'with', 'my', 'your', 'for', '1080p', '720p',
      'game', 'play', 'part', 'ep', 'episode',
      'gameplay', '全dlc', 'dlc', '官方',
      // 游戏分享场景常见"版本描述词"（纯版本描述，非内容关键词）
      '学习版', '免费学习版', '免费学习版下载', '学习版下载', '破解版', '官方中文',
      '硬盘版', '免安装', '免安装硬盘版', '中文版', '官方中文版', '完整版', '绿色版',
      '安装版', '便携版',
    ]);
    // 绝对敏感词：token 只要包含即整体丢弃（B 站审核会因 学习版/破解版/盗版 拒稿）。
    const ABS_SENSITIVE = ['学习版', '破解版', '盗版'];
    const text = (title && String(title).trim()) ? String(title) : (fileName || '');
    const cleaned = String(text)
      .replace(/\.[a-z0-9]+$/i, '') // 去扩展名
      .replace(/^【[^】]*】/, ''); // 剥离开头序号/索引前缀（素材库常见 【游戏268】、【268】 等）
    const seps = /[\s\-_·。，、,.\|/\\+【】（）《》：「」；！？…\x22\x27]+/; // 空格/-/_/·/。/中文标点 + 全角/中文符号与引号
    const rawParts = cleaned.split(seps);
    const seen = new Set();
    const out = [];
    function pushToken(t) {
      t = (t || '').trim();
      if (!t) return;
      if (t.length <= 1) return; // 过短词（含单字）过滤
      if (t.length > 12) return; // 超长 token 过滤（防序号/描述粘连残留）
      if (/^\d+$/.test(t)) return; // 纯数字（序号残留，如 268）
      if (/^第\d+[期集话章弹]?$/.test(t)) return; // 第N期/集/话 等序号，无检索价值
      const key = t.toLowerCase();
      if (seen.has(key)) return; // 去重
      if (STOP_WORDS.has(key)) return; // 停用词过滤
      if (ABS_SENSITIVE.some((s) => key.includes(s))) return; // 敏感词子串过滤（学习版/破解版/盗版）
      seen.add(key);
      out.push(t);
    }
    for (const p of rawParts) pushToken(p);
    // 叠加默认标签（逗号分隔），与已提取词去重合并
    const defaults = String(defaultTags || '')
      .split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    for (const d of defaults) pushToken(d);
    return out.slice(0, 10).join(','); // 限长 ≤10
  }

  // 推荐标签与默认标签合并去重（限长 ≤10，与 genTags 一致）。
  function mergeTags(suggested, defaultTags) {
    const seen = new Set();
    const out = [];
    const add = (t) => {
      t = (t || "").trim();
      if (!t) return;
      if (t.length > 20) return; // B 站单标签上限 20 字，超长直接 21005 拒稿
      if (/学习版|破解版|盗版/i.test(t)) return; // 敏感词不进标签（B 站审核拒稿）
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };
    for (const s of Array.isArray(suggested) ? suggested : []) add(s);
    const defaults = String(defaultTags || "")
      .split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    for (const d of defaults) add(d);
    return out.slice(0, 10).join(",");
  }

  // 选入视频或标题变化时，若用户未手动改过标签，则尝试从 B站标签推荐接口（/api/tags/suggest，
  // 同源代理避免 CORS）生成并填入 tagsInput；接口失败/无推荐时 fallback 到 genTags（文件名分词兜底，离线可用）。
  // 全程自捕获异常：绝不向上抛未捕获异常，也不阻塞交互（调用处 fire-and-forget）。
  async function maybeAutoTag() {
    const tagsEl = $("tagsInput");
    if (!tagsEl) return;
    if (tagsEl.dataset.userEdited === "1") return; // 用户手动改过，尊重用户不覆盖
    if (tagsEl.value.trim()) return; // 已有内容不覆盖
    const fileName = (selectedVideo || "").split(/[\\/]/).pop();
    const title = $("titleInput") ? $("titleInput").value : "";
    const kw = (title && title.trim()) ? title.trim() : fileName;
    if (!kw) return; // 无标题也无文件名，跳过（避免无意义请求）
    const dt = (window.__defaultTags && typeof window.__defaultTags.trim === "function" && window.__defaultTags.trim())
      ? window.__defaultTags : "";
    try {
      const resp = await fetch("/api/tags/suggest?keyword=" + encodeURIComponent(kw));
      if (resp.ok) {
        const j = await resp.json().catch(() => ({ tags: [] }));
        const suggested = Array.isArray(j && j.tags) ? j.tags.filter((t) => typeof t === "string" && t.trim()) : [];
        if (suggested.length) {
          const merged = mergeTags(suggested, dt);
          if (merged) tagsEl.value = merged;
          return;
        }
      }
    } catch (e) {
      // 接口异常（网络/解析/CORS）→ 走 fallback，不阻断交互
    }
    // fallback：文件名/标题分词兜底（genTags 保留为离线兜底）
    const tags = genTags(fileName, title, dt);
    if (tags) tagsEl.value = tags;
  }

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
    if (!running) setCapsule("warn", "投稿状态：就绪（待投稿）");
  }
  function setOffline() {
    if (!running) setCapsule("err", "投稿状态：离线（服务未连接）");
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

  // ── 轻量 Toast（A2：明暗自动适配，3s 自动消失，复用 pop-in 入场；图标用 ico() 内联 SVG）──
  function toast(msg, type) {
    let host = $("toastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "toastHost";
      host.className = "toast-host";
      document.body.appendChild(host);
    }
    const isErr = type === "err";
    // 消息内已内联 ico() SVG（如错误态显式带 cross）时不再叠加 .toast-ico，避免双图标；并用 innerHTML 渲染 SVG。
    const hasInlineIcon = typeof msg === "string" && msg.indexOf("ico(") !== -1;
    const el = document.createElement("div");
    el.className = "toast pop-in";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="toast-ico"></span><span class="toast-msg"></span>';
    el.querySelector(".toast-ico").innerHTML = hasInlineIcon ? "" : (isErr ? ico("cross") : ico("check"));
    const msgEl = el.querySelector(".toast-msg");
    if (hasInlineIcon) msgEl.innerHTML = msg; else msgEl.textContent = msg;
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
  function pushHistory(key, ok, title, status, bvid) {
    const list = loadHistoryBiliup(key);
    list.unshift({ ts: Date.now(), ok: !!ok, title: title || "（未命名）", status: status || "", bvid: bvid || "" });
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
        updateTitleCount(); // 同步标题字节计数（B站 APP 接口按 UTF-8 字节限长）
        $("submitHint").textContent = "已选择视频，点击投稿";
        if ($("clearBtn")) $("clearBtn").style.display = ""; // 显示「清空选择」（B）
        maybeAutoTag(); // #② 选入视频后自动生成标签（用户未手动填时）
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
      updateTitleCount();
      const ti = $("tagsInput");
      if (ti) { ti.value = ""; ti.dataset.userEdited = ""; } // 重置标签（含手动编辑标记）
      $("submitHint").textContent = "选择视频后点击投稿（发布前会二次确认模式）";
    });
  }

  // ── 标签输入：用户手动编辑后标记，避免自动生成覆盖（#②）──
  const tagsInputEl = $("tagsInput");
  if (tagsInputEl) {
    tagsInputEl.addEventListener("input", () => { tagsInputEl.dataset.userEdited = "1"; });
  }
  // 标题变化也可能改变自动标签（用户未手动填标签时）
  const titleInputEl = $("titleInput");
  if (titleInputEl) {
    titleInputEl.addEventListener("input", () => { maybeAutoTag(); updateTitleCount(); });
  }

  // 标题/文件名计数：B站投稿接口按「字符数」校验（上限 80 字），且单P标题取文件名。
  // 超限标红并拦截提交（提示用户自行修改/重命名），不自动截断。
  function updateTitleCount() {
    const el = $("titleCount");
    const inp = $("titleInput");
    if (!el || !inp) return;
    const n = (inp.value || "").length;
    el.textContent = String(n);
    el.classList.toggle("over", n > 80);
    const fc = $("fileNameCount");
    if (fc) {
      if (!selectedVideo) {
        fc.textContent = "未选视频";
        fc.classList.remove("over");
      } else {
        const base = selectedVideo.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
        fc.textContent = "文件名 " + base.length + "/80 字" + (base.length > 80 ? "（超限，请重命名文件）" : "");
        fc.classList.toggle("over", base.length > 80);
      }
    }
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
      // 分集：仅当配置明确指定时回填。为空时保留 refreshSeasons→fillSections 已自动选中的首个分集，
      // 避免老配置「选了合集但没选分集」在加载时被清空，导致合集后置被跳过（需求①回归实测）。
      if (cfg.sectionId) selectPreserve($("cfgSection"), cfg.sectionId);
      selectPreserve($("cfgCopyright"), cfg.copyright != null ? cfg.copyright : "");
      selectPreserve($("cfgNoReprint"), cfg.noReprint != null ? cfg.noReprint : "");
      selectPreserve($("cfgLine"), cfg.line || "");
      $("cfgUid").value = cfg.uid != null ? cfg.uid : "";
      $("cfgDesc").value = cfg.desc || "";
      $("cfgComment").value = cfg.comment || "";
      // #② 默认标签：读入 settings 输入框 + 缓存到 window，供 maybeAutoTag 叠加。
      if ($("defaultTagsInput")) $("defaultTagsInput").value = cfg.defaultTags || "";
      window.__defaultTags = cfg.defaultTags || "";
      const ck = cfg.cookiesDetail || { ok: !!cfg.cookiesOk };
      const ckMsg = ck.message || (ck.ok ? "有效" : "缺失 SESSDATA/bili_jct");
      $("cookiesKpi").textContent = "cookies: " + ckMsg;
      $("cookiesKpi").style.color = ck.ok ? "" : "#ff8a8a";
    } catch (e) {
      logLine("加载配置失败: " + e.message, "err");
    }
  }

  // ── 合集/分集级联下拉（#H）──
  // seasonSections: seasonId -> [{ id, title }]，供分集下拉级联填充。
  let seasonSections = Object.create(null);
  let seasonNoSection = Object.create(null);
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
    let chosen = "";
    if (prev) {
      selectPreserve(selSection, prev);
      if (selSection.value === prev) chosen = prev;
    } else if (secs.length > 0) {
      // 2) 用户未选分集但合集下有分集 → 自动选中第一个（B 站创建合集时自动建默认分集
      //    「正片」，通常排第一；用户只传单视频时无需手动选分集，否则 sectionId 为空
      //    会导致 task.js 跳过合集后置——这正是「选了合集却加不进合集」的根因）。
      //    多分集时默认选第一个，用户仍可手动改。
      selSection.value = String(secs[0].id);
      chosen = selSection.value;
    }
    // 注：合集下无分集（secs 为空）时保持「不指定分集」，updateSectionHint 给出温和提示。
    updateSectionHint(seasonId, secs);
    return chosen;
  }
  // 分集下拉为空时给明确提示，避免「选合集却静默不后置」的困惑（需求①）。
  function updateSectionHint(seasonId, secs) {
    const hint = $("sectionHint");
    if (!hint) return;
    if (seasonId && (!secs || secs.length === 0)) {
      // 区分「无分集结构」与「分集列表未取到」：实测 no_section=1 的合集仍可能有默认「正片」分集，
      // 因此两处均为空时不再断言「必须建分集」，而是提示确认/重试。
      hint.textContent = seasonNoSection[seasonId]
        ? "该合集未返回分集列表（视频不会自动加入合集，可重新加载列表或到创作中心确认）"
        : "该合集暂未取到分集列表（可不指定直接上传，或稍后重试）";
    } else {
      hint.textContent = "（可选：选中分集后，上传将归入该分集）";
    }
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
        seasonNoSection = Object.create(null);
        for (const s of seasons) {
          const opt = document.createElement("option");
          opt.value = String(s.id);
          opt.textContent = (s.title != null && s.title !== "") ? s.title : s.id;
          selSeason.appendChild(opt);
          seasonSections[s.id] = Array.isArray(s.sections) ? s.sections : [];
          if (s.no_section) seasonNoSection[s.id] = true;
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
      defaultTags: ($("defaultTagsInput") ? $("defaultTagsInput").value : "") || "", // #② 默认标签
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
        toast("参数已保存", "ok"); // A2：轻量提示
        loadConfig(); // 回填最新值（含转载 noReprint=0 等）
      } else {
        logLine("保存失败: " + (j.error || ""), "err");
        toast("保存失败", "err");
      }
    } catch (e) {
      logLine("保存配置失败: " + e.message, "err");
      toast(ico('cross') + ' 保存失败', 'err');
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
    closeAccountMenu();
    if (info && info.isLogin) {
      const line = document.createElement("div");
      line.className = "acct-line";
      const img = document.createElement("img");
      img.className = "avatar";
      img.id = "avatar";
      const face = (info.face || "").trim();
      // #A：经 /api/avatar 代理绕过防盗链；face 为空则直接用默认头像。
      img.referrerPolicy = 'no-referrer';
      img.src = face ? ('/api/avatar?face=' + encodeURIComponent(face)) : DEFAULT_AVATAR_SVG;
      img.alt = info.uname || "用户";
      img.title = (info.uname || "") + "（点击打开菜单）";
      img.onerror = () => { img.onerror = null; img.src = DEFAULT_AVATAR_SVG; };
      // #③ 头像点击 → 弹出二级菜单（个人中心 / 退出登录），不再平铺退出按钮。
      img.addEventListener("click", (e) => { e.stopPropagation(); toggleAccountMenu(info, img); });
      const name = document.createElement("span");
      name.className = "nick-name";
      name.id = "nickName";
      name.textContent = info.uname || "用户";
      name.title = "点击打开菜单";
      name.addEventListener("click", (e) => { e.stopPropagation(); toggleAccountMenu(info, name); });
      line.appendChild(img);
      line.appendChild(name);
      box.appendChild(line);
      // 登录态剩余天数徽章（醒目）：正常绿 / 临期橙 / 失效红，点击唤起扫码
      const ttl = info.loginTtl;
      if (ttl) {
        const badge = document.createElement("span");
        let cls = "ttl-ok";
        let text = "登录态正常";
        if (ttl.days != null) {
          if (ttl.days <= 0) { cls = "ttl-dead"; text = "登录态即将失效，请重新扫码"; }
          else if (ttl.status === "warn") { cls = "ttl-warn"; text = "登录态剩余 " + ttl.days + " 天，请提前重新扫码"; }
          else { text = "登录态剩余 " + ttl.days + " 天"; }
        }
        badge.className = "login-ttl " + cls;
        badge.innerHTML = '<span class="dot"></span>' + text;
        badge.title = "点击重新扫码登录";
        badge.addEventListener("click", (e) => { e.stopPropagation(); openLogin(); });
        box.appendChild(badge);
      }
      buildAccountMenu(info); // 构建二级菜单（个人中心 / 退出登录）
    } else {
      const btn = document.createElement("button");
      btn.className = "auth-btn";
      btn.id = "loginBtn";
      btn.innerHTML = ico("key") + " 登录B站";
      btn.addEventListener("click", openLogin);
      box.appendChild(btn);
    }
  }

  // ── 账号二级菜单（#③：头像/昵称点击弹出「个人中心 / 退出登录」）──
  // 个人中心：复用 openSpace(mid) → 优先 shell.openExternal，回退 window.open。
  // 退出登录：复用 doLogout（原平铺按钮改由菜单项触发）。点击外部/失焦关闭。
  const ACCT_MENU_ICON_USER = '<svg class="app-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const ACCT_MENU_ICON_LOGOUT = '<svg class="app-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';

  let accountMenuEl = null;
  function ensureAccountMenu() {
    if (accountMenuEl) return accountMenuEl;
    const menu = document.createElement("div");
    menu.className = "acct-menu";
    menu.id = "accountMenu";
    menu.style.display = "none";
    menu.setAttribute("role", "menu");
    if (document.body) document.body.appendChild(menu);
    accountMenuEl = menu;
    return menu;
  }
  function buildAccountMenu(info) {
    const menu = ensureAccountMenu();
    menu.innerHTML = "";
    const itemProfile = document.createElement("button");
    itemProfile.type = "button";
    itemProfile.className = "acct-menu-item";
    itemProfile.setAttribute("role", "menuitem");
    itemProfile.innerHTML = ACCT_MENU_ICON_USER + "<span>个人中心</span>";
    itemProfile.addEventListener("click", () => { closeAccountMenu(); openSpace(info.mid); });
    const itemLogout = document.createElement("button");
    itemLogout.type = "button";
    itemLogout.className = "acct-menu-item acct-menu-item--danger";
    itemLogout.setAttribute("role", "menuitem");
    itemLogout.innerHTML = ACCT_MENU_ICON_LOGOUT + "<span>退出登录</span>";
    itemLogout.addEventListener("click", () => { closeAccountMenu(); doLogout(); });
    menu.appendChild(itemProfile);
    menu.appendChild(itemLogout);
  }
  function toggleAccountMenu(info, anchor) {
    const menu = ensureAccountMenu();
    if (menu.style.display === "block") { closeAccountMenu(); return; }
    const r = (anchor && typeof anchor.getBoundingClientRect === "function")
      ? anchor.getBoundingClientRect() : { bottom: 0, right: 0 };
    menu.style.top = (r.bottom + 6) + "px";
    menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
    menu.style.display = "block";
    menu._mid = info.mid;
    // 点击外部/失焦关闭（capture 阶段监听，避免冒泡干扰菜单内点击）。
    setTimeout(() => {
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("click", onDocClickCloseMenu, true);
      }
    }, 0);
  }
  function onDocClickCloseMenu(e) {
    const menu = accountMenuEl;
    if (!menu) return;
    if (menu.contains(e.target)) return; // 点击菜单项由各自 handler 处理
    const area = (typeof document !== "undefined" && typeof document.getElementById === "function")
      ? document.getElementById("accountArea") : null;
    if (area && area.contains(e.target)) return; // 点击头像/昵称交给 toggle 处理
    closeAccountMenu();
  }
  function closeAccountMenu() {
    const menu = accountMenuEl;
    if (menu) menu.style.display = "none";
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("click", onDocClickCloseMenu, true);
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
      if (j && j.ok) toast("已退出登录", "ok");
      else toast("退出登录失败", "err");
    } catch (e) {
      toast("退出登录失败: " + e.message, "err");
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
        // 显示 cookie 自动验证结果（后端 /api/login/poll 已调 B站 nav 校验）
        const v = j.verified;
        if (v && v.ok) {
          toast("登录成功 ✓ @" + (v.uname || "B站账号"), "ok");
          $("loginStatus").textContent = "登录成功，cookie 有效";
        } else if (v) {
          toast("登录成功，但 cookie 验证未通过：" + (v.message || "请检查登录态"), "err");
          $("loginStatus").textContent = "[警告] cookie 验证未通过，投稿可能失败";
        } else {
          toast("登录成功", "ok");
        }
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
    if (!selectedVideo) { logLine("请先选择视频文件", "err"); toast("请先选择视频文件", "err"); return; }
    // B站单P标题取文件名：文件名超 80 字必失败（code=21104），先拦截提示重命名，不自动截断。
    const fileNameBase = selectedVideo.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    if (fileNameBase.length > 80) {
      const m = "文件名超 B 站 80 字限制（" + fileNameBase.length + " 字）：B站单P标题取文件名，发布会失败，请先重命名视频文件";
      logLine(m, "err"); toast(m, "err"); return;
    }
    const titleVal = ($("titleInput").value || "").trim();
    if (titleVal.length > 80) {
      const m = "标题超 B 站 80 字限制（" + titleVal.length + " 字），请修改标题后再投稿";
      logLine(m, "err"); toast(m, "err"); return;
    }
    const mode = document.querySelector('input[name="mode"]:checked').value;
    let dtime = 0;
    if (mode === "dtime") {
      const v = $("dtimeInput").value;
      if (!v) { logLine("请填写定时发布时间", "err"); toast("请填写定时发布时间", "err"); return; }
      dtime = Math.floor(new Date(v).getTime() / 1000);
      if (!dtime || isNaN(dtime)) { logLine("定时时间无效", "err"); toast("定时时间无效", "err"); return; }
    }
    const tags = ($("tagsInput").value || "")
      .split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      videoPath: selectedVideo,
      title: titleVal,
      tags,
      publishMode: mode,
      dtime,
    };

    running = true;
    setExec($("submitBtn"), true);
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
      setExec($("submitBtn"), false);
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
    logLine("投稿完成！aid=" + (d.aid || "?") + " bvid=" + (d.bvid || "?") + " cid=" + (d.cid || "?") + " 合集=" + (d.season ? "已加" : "否"), "ok");
    // P08：写一条投稿历史（成功/失败 + 稿件标题 + 时间 + 简要状态）
    pushHistory(HISTORY_KEY_BILIUP, ok, $("titleInput").value || "（未命名）", ok ? ("投稿成功" + (d.bvid ? " · " + d.bvid : "")) : (d.error || "投稿未完成"), d.bvid);
  } else if (ev.type === "error") {
    setCapsule("err", "失败");
    logLine("失败@" + (ev.stage || "") + ": " + (ev.message || ""), "err");
    // P08：写一条投稿历史（失败）
    pushHistory(HISTORY_KEY_BILIUP, false, $("titleInput").value || "（未命名）", ev.message || "投稿失败");
  }
  }

  $("submitBtn").addEventListener("click", openConfirm);
  $("confirmOk").addEventListener("click", () => { closeConfirm(); submit(); });

  // ── 检测补合集：拉最近发布、不在所选合集的稿件，勾选后一键补加 ──
  let detectCandidates = [];
  function openDetectModal() {
    const mask = $("seasonDetectMask");
    if (mask) openModal(mask);
  }
  function closeDetectModal() {
    const mask = $("seasonDetectMask");
    if (mask) closeModal(mask);
  }
  function renderDetectCandidates(list) {
    const el = $("seasonDetectList");
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '<div style="padding:12px 0;color:var(--text-dim)">没有发现未加入所选合集的稿件。</div>';
      return;
    }
    el.innerHTML = list.map((c, i) => {
      const dt = c.pubdate ? new Date(c.pubdate * 1000).toLocaleString() : "";
      return '<label style="display:flex;align-items:flex-start;gap:8px;padding:7px 4px;border-bottom:1px dashed var(--glass-border);cursor:pointer;">'
        + '<input type="checkbox" data-idx="' + i + '" checked style="margin-top:3px;" />'
        + '<span style="flex:1;min-width:0;">' + (c.title || c.bvid || c.aid) + (dt ? ' <span style="opacity:.6;font-size:11px;">' + dt + "</span>" : "") + "</span></label>";
    }).join("");
  }
  async function runSeasonDetect() {
    const btn = $("scanJobsBtn");
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch("/api/season/detect?limit=20");
      const j = await resp.json();
      if (!resp.ok || !j.ok) {
        logLine("检测补合集失败: " + ((j && j.error) || resp.status), "err");
        toast("检测失败：" + ((j && j.error) || resp.status), "err");
        return;
      }
      detectCandidates = (j.candidates || []).filter((c) => c && (c.aid || c.bvid));
      const hint = $("seasonDetectHint");
      if (hint) {
        hint.textContent = detectCandidates.length
          ? "以下稿件尚未加入所选合集，勾选后点「加入所选合集」："
          : "最近发布的稿件都已加入所选合集（或暂无新的可补稿件）。";
      }
      renderDetectCandidates(detectCandidates);
      openDetectModal();
    } catch (e) {
      logLine("检测补合集异常: " + e.message, "err");
      toast("检测异常", "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  async function submitDetectAdd() {
    const boxes = Array.prototype.slice.call(document.querySelectorAll('#seasonDetectList input[type="checkbox"]'));
    const selected = boxes
      .filter((b) => b.checked)
      .map((b) => {
        const c = detectCandidates[Number(b.getAttribute("data-idx"))];
        return c ? { aid: c.aid, cid: c.cid, title: c.title } : null;
      })
      .filter(Boolean);
    if (!selected.length) {
      toast("未选择任何稿件", "err");
      return;
    }
    const btn = $("seasonDetectOk");
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch("/api/season/add-many", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: selected }),
      });
      const j = await resp.json();
      if (j && j.ok) {
        logLine("补加合集完成：成功 " + j.okCount + "/" + j.total, "ok");
        toast("补加成功 " + j.okCount + "/" + j.total, "ok");
        closeDetectModal();
      } else {
        logLine("补加合集失败: " + ((j && j.error) || resp.status), "err");
        toast("补加失败：" + ((j && j.error) || resp.status), "err");
      }
    } catch (e) {
      logLine("补加合集异常: " + e.message, "err");
      toast("补加异常", "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  const detectBtn = $("scanJobsBtn");
  if (detectBtn) detectBtn.addEventListener("click", runSeasonDetect);
  const detectOk = $("seasonDetectOk");
  if (detectOk) detectOk.addEventListener("click", submitDetectAdd);
  const detectCancel = $("seasonDetectCancel");
  if (detectCancel) detectCancel.addEventListener("click", closeDetectModal);
  const detectClose = $("seasonDetectClose");
  if (detectClose) detectClose.addEventListener("click", closeDetectModal);

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
  let historyFilter = "ok"; // 默认显示成功

  function renderBiliupHistory() {
    const all = loadHistoryBiliup(HISTORY_KEY_BILIUP);
    const list = historyFilter === "all"
      ? all
      : all.filter((h) => (historyFilter === "ok" ? h.ok : !h.ok));
    if (!list.length) {
      historyListBiliup.innerHTML = '<div class="empty-state"><span class="es-ico">' + ico('inbox') + '</span>'
        + (all.length ? "没有符合条件的投稿记录" : "还没有投稿记录") + "</div>";
      return;
    }
    historyListBiliup.innerHTML = list.map((h) => {
      const time = new Date(h.ts).toLocaleString("zh-CN");
      const badge = h.ok ? "成功" : "失败";
      const link = h.ok && h.bvid
        ? '<a href="https://www.bilibili.com/video/' + encodeURIComponent(h.bvid)
          + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;border-bottom:1px dashed var(--accent);">'
          + escapeHtmlBiliup(h.bvid) + "（打开）</a>"
        : escapeHtmlBiliup(h.status || "");
      const metaParts = [badge];
      if (link) metaParts.push(link);
      metaParts.push(time);
      return `<div class="history-item">
        <span class="history-dot ${h.ok ? "ok" : "err"}"></span>
        <div class="history-main">
          <div class="history-title">${escapeHtmlBiliup(h.title)}</div>
          <div class="history-meta">${metaParts.map((p) => (p.indexOf('<a ') === 0 ? p : escapeHtmlBiliup(p))).join(" · ")}</div>
        </div>
      </div>`;
    }).join("");
  }
  function setHistoryFilter(f) {
    historyFilter = f;
    const tabs = document.querySelectorAll("#historyTabs .history-tab");
    tabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-filter") === f));
    renderBiliupHistory();
  }
  function openBiliupHistory() { renderBiliupHistory(); openModal(historyMaskBiliup); }
  if (historyBtnBiliup) historyBtnBiliup.addEventListener("click", openBiliupHistory);
  if (historyCloseBiliup) historyCloseBiliup.addEventListener("click", closeModal);
  if (historyMaskBiliup) historyMaskBiliup.addEventListener("click", (e) => { if (e.target === historyMaskBiliup) closeModal(); });
  document.querySelectorAll("#historyTabs .history-tab").forEach((t) => {
    t.addEventListener("click", () => setHistoryFilter(t.getAttribute("data-filter") || "all"));
  });
  if (historyClearBiliup) historyClearBiliup.addEventListener("click", () => {
    if (window.confirm("确定清空全部投稿历史?")) {
      try { localStorage.removeItem(HISTORY_KEY_BILIUP); } catch { /* ignore */ }
      renderBiliupHistory();
    }
  });

  // ── 待发布清单（弹窗版：名称 + 待发布日期 + 有资源/已发布，双勾=完成）──
  let pvList = [];
  let pvTab = "todo";
  const pvListMask = $("pvListMask");
  const pvAddMask = $("pvAddMask");
  const pvListEl = $("pvList");
  const pvStatsEl = $("pvStats");
  const pvNameInput = $("pvName");
  const pvDateInput = $("pvDate");

  const pvDone = (x) => !!(x.hasResource && x.published);
  const pvDateKey = (x) => (x.publishDate || "").trim() || "9999-99-99";

  async function loadPendingVideos() {
    try {
      const r = await fetch("/api/pending-videos");
      const d = await r.json();
      pvList = (d && d.list) || [];
    } catch (e) {
      pvList = [];
    }
    renderPendingVideos();
  }

  function pvSorted(arr) {
    return arr.slice().sort((a, b) => pvDateKey(a).localeCompare(pvDateKey(b)));
  }

  function renderPendingVideos() {
    const done = pvSorted(pvList.filter(pvDone));
    const todo = pvSorted(pvList.filter((x) => !pvDone(x)));
    const show = pvTab === "done" ? done : todo;
    $("pvTabTodo").classList.toggle("active", pvTab !== "done");
    $("pvTabDone").classList.toggle("active", pvTab === "done");
    pvStatsEl.textContent =
      "待发布 " + pvList.length +
      " · 有资源 " + pvList.filter((x) => x.hasResource).length +
      " · 已发布 " + pvList.filter((x) => x.published).length +
      " · 完成 " + done.length;
    pvListEl.innerHTML = show.length
      ? show.map((x, i) => {
          const d = (x.publishDate || "").trim();
          return (
            '<div class="pv-item' + (pvDone(x) ? " done" : "") + '" style="animation-delay:' + (i * 55) + 'ms">' +
            '<span class="pv-name">' + escapeHtmlBiliup(x.name) + "</span>" +
            '<span class="pv-date">' + (d ? escapeHtmlBiliup(d.slice(5)) : "未定") + "</span>" +
            '<label class="pv-check"><input type="checkbox" data-id="' + x.id + '" data-key="hasResource"' + (x.hasResource ? " checked" : "") + "> 有资源</label>" +
            '<label class="pv-check"><input type="checkbox" data-id="' + x.id + '" data-key="published"' + (x.published ? " checked" : "") + "> 已发布</label>" +
            '<button class="pv-del" data-id="' + x.id + '" type="button">删除</button>' +
            "</div>"
          );
        }).join("")
      : '<div class="hint">暂无' + (pvTab === "done" ? "已完成" : "待完成") + "记录</div>";
  }

  async function pvMutate(url, opts) {
    const r = await fetch(url, Object.assign({ method: "POST", headers: { "Content-Type": "application/json" } }, opts));
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.error || ("请求失败 " + r.status));
    return d;
  }

  $("pvOpenBtn").addEventListener("click", () => {
    pvListMask.classList.add("show");
    loadPendingVideos();
  });
  $("pvCloseBtn").addEventListener("click", () => pvListMask.classList.remove("show"));

  $("pvAddBtn").addEventListener("click", () => {
    pvNameInput.value = "";
    pvDateInput.value = "";
    $("pvAddHas").checked = false;
    $("pvAddPub").checked = false;
    pvAddMask.classList.add("show");
  });
  $("pvAddCancel").addEventListener("click", () => pvAddMask.classList.remove("show"));
  $("pvAddClose").addEventListener("click", () => pvAddMask.classList.remove("show"));
  $("pvAddOk").addEventListener("click", async () => {
    const name = (pvNameInput.value || "").trim();
    if (!name) { toast("请输入视频名称", "err"); return; }
    try {
      await pvMutate("/api/pending-videos", {
        body: JSON.stringify({
          name,
          publishDate: pvDateInput.value || "",
          hasResource: $("pvAddHas").checked,
          published: $("pvAddPub").checked,
        }),
      });
      pvAddMask.classList.remove("show");
      await loadPendingVideos();
    } catch (e) { toast(e.message, "err"); }
  });
  pvNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("pvAddOk").click(); }
  });

  pvListEl.addEventListener("change", async (e) => {
    const cb = e.target.closest('input[data-key]');
    if (!cb) return;
    try {
      const patch = {};
      patch[cb.dataset.key] = cb.checked;
      await pvMutate("/api/pending-videos/" + cb.dataset.id, { body: JSON.stringify(patch) });
      await loadPendingVideos();
    } catch (err) { toast(err.message, "err"); }
  });
  pvListEl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".pv-del");
    if (!btn) return;
    await fetch("/api/pending-videos/" + btn.dataset.id, { method: "DELETE" });
    await loadPendingVideos();
  });
  $("pvTabTodo").addEventListener("click", () => { pvTab = "todo"; renderPendingVideos(); });
  $("pvTabDone").addEventListener("click", () => { pvTab = "done"; renderPendingVideos(); });
  $("pvClearDone").addEventListener("click", async () => {
    try { await pvMutate("/api/pending-videos/clear-done"); await loadPendingVideos(); } catch (e) { toast(e.message, "err"); }
  });

  // ── 初始化 ──
  refreshSeasons().finally(() => loadConfig()); // chain: 先 populate 下拉再 apply cfg 避免 race
  refreshAccount();
  refreshHealth();
  setInterval(refreshHealth, 20000); // 每 20s 探活
  if (typeof window.bindStatusCursor === "function") window.bindStatusCursor(document);

  // 后台事件订阅：定时发布「待置顶」自动完成 → toast + 日志
  try {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (!d || d.type !== "pendingPinDone") return;
      toast("定时发布评论已自动置顶" + (d.bvid ? "（" + d.bvid + "）" : ""), "ok");
      logLine("后台自动置顶完成：" + (d.bvid || ("aid=" + d.aid)), "ok");
    };
    es.onerror = () => { try { es.close(); } catch (_) {} };
  } catch (_) { /* EventSource 不可用则忽略 */ }

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
