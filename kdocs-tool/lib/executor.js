// ── 一键执行编排 ──
const fs = require("fs");
const path = require("path");
const steam = require("./steam");
const kdocs = require("./kdocs");
const gamecloud = require("./gamecloud");
const { isBadIntro, normalizeSize, isChineseText } = require("./constants");

// ── 分类标签默认值（写入记录「游戏信息」字段，与 parser 关键词检测的 tags 并存且去重）──
// 背景：金山文档「游戏信息」列是 multi-select，用户每次新建记录都要手动勾选默认的几个标签（见 issue/用户反馈）。
// 这里把用户的默认偏好下沉到工具侧：自动勾上免安装硬盘版/PC游戏/全DLC，省去金文档端的重复操作。
// 前端可在选择框里临时增删（通过 opts.classificationTags 覆盖），不影响其它记录的默认行为。
const DEFAULT_CLASSIFICATION_TAGS = ["免安装硬盘版", "PC游戏", "全DLC"];

// 默认依赖（真实实现）；测试可通过 opts.deps 覆盖任意项注入 mock
const DEFAULT_DEPS = {
  fs,
  searchSteamAppId: steam.searchSteamAppId,
  getSteamAppDetails: steam.getSteamAppDetails,
  fetchAppIdFromWikidata: steam.fetchAppIdFromWikidata,
  fetchAppIdFromBaiduBaike: steam.fetchAppIdFromBaiduBaike,
  fetchAppIdFromWebSearch: steam.fetchAppIdFromWebSearch,
  fetchWikiIntro: steam.fetchWikiIntro,
  resolveEnglishName: steam.resolveEnglishName,
  downloadCover: steam.downloadCover,
  downloadCoverFromUrl: steam.downloadCoverFromUrl,
  callMcporter: kdocs.callMcporter,
  checkKdocsReady: kdocs.checkKdocsReady,
  fileBase64: kdocs.fileBase64,
  // 云库线路（游戏库网站后端）：整对象注入，测试可整体替身，无需联网
  cloud: gamecloud,
};

// ── 录入线路解析 ──
// opts.targets = { kdocs?:boolean, cloud?:boolean }
// 缺省（undefined）时**只走金山** —— 这是历史行为契约：既有调用方（含全部单测）不传 targets，
// 必须保持「只写金山」。UI 侧会显式传两个勾选框的值（默认都勾），所以用户拿到的是双线路。
function resolveTargets(targets) {
  if (!targets || typeof targets !== "object") return { kdocs: true, cloud: true };
  return {
    kdocs: targets.kdocs !== false,
    cloud: targets.cloud === true,
  };
}

// ── 查重：翻页拉全表，比对「游戏名称」字段，精确匹配 parsed.raw ──
// 返回 { exists, recordId, existingLinks:{baidu,quark,xunlei} }
// deps 可注入（测试用）；默认走真实 kdocs
async function findExistingRecord(parsed, deps = DEFAULT_DEPS) {
  const target = parsed.raw;
  let offset = "";
  let match = null;
  let page = 0;
  const MAX_PAGES = 50; // 防 API 异常持续返回 offset 导致无限翻页
  while (page < MAX_PAGES) {
    page++;
    const res = await deps.callMcporter("dbsheet.list_records", { sheet_id: 1, page_size: 100, offset });
    const detail = res && res.data && res.data.detail;
    const recs = (detail && detail.records) || [];
    for (const r of recs) {
      const name = r.fields && r.fields["游戏名称"];
      if (name === target) { match = { recordId: r.id, fields: r.fields || {} }; break; }
    }
    if (match) break;
    if (detail && detail.offset) offset = detail.offset;
    else break;
  }
  if (!match) return { exists: false, recordId: null, existingLinks: null };
  const f = match.fields;
  return {
    exists: true,
    recordId: match.recordId,
    existingLinks: {
      baidu: f["百度网盘"] || null,
      quark: f["夸克网盘"] || null,
      xunlei: f["迅雷网盘"] || null,
    },
  };
}

async function autoExecuteKdocs(parsed, manualAppId, coverDir, opts = {}, shared = {}) {
  const deps = { ...DEFAULT_DEPS, ...(opts.deps || {}) };
  const manualCoverUrl = (opts.manualCoverUrl || "").trim();
  const forceAdd = !!opts.forceAdd;
  const updateLinks = !!opts.updateLinks;
  // 分类标签：opts 显式传（即使是空数组）即用之；未传（undefined）走 buildRecordFields 内置默认
  // 行为契约：空数组 = 用户显式清空，不要自动回填默认
  const classificationTags = Array.isArray(opts.classificationTags)
    ? opts.classificationTags.filter(t => typeof t === "string" && t.trim())
    : undefined;
  const steps = [];
  let stepIdx = -1;
  // onStep 实时回调（SSE 流式进度用）；不传则无副作用（保持测试兼容）
  // 统一打上 group:"kdocs" —— 前端按线路分容器渲染，两条线路的步骤不会互相覆盖 index
  const emitRaw = typeof opts.onStep === "function" ? opts.onStep : () => {};
  const emit = (ev) => emitRaw({ ...ev, group: "kdocs" });
  const ok = (s) => { steps[stepIdx] = { ...s, status: "成功" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const skip = (s) => { steps[stepIdx] = { ...s, status: "跳过" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const fail = (s) => { steps[stepIdx] = { ...s, status: "失败" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  // 警告：步骤尝试过但出错/降级（如封面下载真实报错）。不算「失败」(不拉红整体)，
  // 但也不该被当成「跳过」洗白——单独状态供前端显式提示（P0-1 修复）。
  const warn = (s) => { steps[stepIdx] = { ...s, status: "警告" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const doing = (s) => { stepIdx = steps.length; steps.push({ ...s, status: "进行中" }); emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };

  // 1. 检查 kdocs
  doing({ name: "检查 kdocs 连接" });
  if (!(await deps.checkKdocsReady())) {
    steps[stepIdx].status = "失败";
    steps[stepIdx].error = "kdocs-qclaw 未配置，请先运行 setup 脚本";
    emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } });
    const result = { steps, recordId: null, success: false, action: "failed", gameName: parsed.raw };    return result;
  }
  ok({ name: "kdocs 连接" });

  // 1.5 查重（真比对）：命中重复时按 forceAdd / updateLinks / 默认跳过 分支处理
  doing({ name: "查重（比对已有记录）" });
  const dup = await findExistingRecord(parsed, deps);
  if (!dup.exists) {
    ok({ name: "查重通过（无重复）" });
  } else if (forceAdd) {
    // 强制新增：忽略重复，继续走完整创建流程
    ok({ name: "查重命中但强制新增", recordId: dup.recordId });
  } else if (updateLinks) {
    // 部分更新网盘链接：只更新本次输入中带了的网盘类型，不跑 bl/封面/介绍/上传
    ok({ name: "查重命中，执行更新网盘链接", recordId: dup.recordId });
    const upFields = {};
    if (parsed.baiduUrl) upFields["百度网盘"] = [{ address: parsed.baiduUrl, displayText: parsed.baiduUrl }];
    if (parsed.quarkUrl) upFields["夸克网盘"] = [{ address: parsed.quarkUrl, displayText: parsed.quarkUrl }];
    if (parsed.xunleiUrl) upFields["迅雷网盘"] = [{ address: parsed.xunleiUrl, displayText: parsed.xunleiUrl }];
    if (Object.keys(upFields).length === 0) {
      // 本次未包含任何网盘链接，无内容可更新
      ok({ name: "无网盘链接可更新", reason: "本次输入未包含任何网盘链接，无需更新" });
      const result = { steps, recordId: dup.recordId, success: true, action: "skipped", gameName: parsed.raw };      return result;
    }
    doing({ name: "更新网盘链接" });
    try {
      await deps.callMcporter("dbsheet.update_records", { sheet_id: 1, records: [{ id: dup.recordId, fields: upFields }] });
      const updatedLinks = Object.keys(upFields).map(k => k.replace("网盘", "")).join("/");
      ok({ name: "更新网盘链接", recordId: dup.recordId, updatedLinks });
      // 后置验证：确认更新已生效
      doing({ name: "验证更新" });
      try {
        await deps.callMcporter("dbsheet.get_record", { sheet_id: 1, record_id: dup.recordId });
        ok({ name: "更新验证通过" });
      } catch (e) { skip({ name: "更新验证", reason: e.message }); }
      const result = { steps, recordId: dup.recordId, success: true, action: "updated", gameName: parsed.raw };      return result;
    } catch (e) {
      fail({ name: "更新网盘链接", error: e.message });
      const result = { steps, recordId: dup.recordId, success: false, action: "update_failed", gameName: parsed.raw };      return result;
    }
  } else {
    // 默认：已存在则跳过，不创建不改写
    ok({ name: "查重命中，已存在（跳过）", recordId: dup.recordId });
    const result = { steps, recordId: dup.recordId, success: true, action: "skipped", gameName: parsed.raw };    return result;
  }

  // 2.0 前置：解析游戏英文名（中文名 → 英文名）
  //     因为 Steam 商店与 Wikidata 多以英文名为准，直接用中文名搜常搜不到或错配。
  //     先拿到规范英文名，再用英文名（优先）去匹配，显著提升命中率。
  //     手动录入的英文名优先于自动解析；已拿到 appid 时跳过解析省一次请求。
  let appid = manualAppId || parsed.appid || null; // 手动录入 > 粘贴的 Steam 链接(appid) > 自动解析
  let appidSource = manualAppId ? "手动录入" : (parsed.appid ? "手动链接" : "");
  let englishName = parsed.englishName || "";
  if (!appid && !englishName) {
    doing({ name: "解析游戏英文名" });
    const resolved = await deps.resolveEnglishName(parsed.gameName);
    if (resolved) { englishName = resolved; ok({ name: "游戏英文名", englishName }); }
    else skip({ name: "游戏英文名", reason: "未解析到（将直接用中文名匹配）" });
  } else {
    // 不静默跳过：输入已含英文名或 AppID 时也展示原因，避免用户误以为没解析英文名
    doing({ name: "解析游戏英文名" });
    skip({
      name: "解析游戏英文名",
      reason: englishName ? "输入已含英文名（" + englishName + "），跳过自动解析" : "已有 Steam AppID，跳过英文名解析",
    });
  }
  const en = englishName; // 后续统一用 en / parsed.gameName 双语言匹配

  // 2.1 取拿 Steam AppID（优先英文名，否则中文名；多源兜底：Steam 搜索 → 维基 → 百度 → 网页）
  //     拿到 AppID 后即可统一兜底封面 / 游戏简介 / 游戏大小（Steam 官方数据最稳）。
  doing({ name: "搜索 Steam AppID" });
  if (!appid) {
    if (en) appid = await deps.searchSteamAppId(en);
    if (!appid) appid = await deps.searchSteamAppId(parsed.gameName);
    if (appid) appidSource = "Steam 搜索";
  }
  if (!appid) {
    const fromWiki = (en && await deps.fetchAppIdFromWikidata(en))
      || await deps.fetchAppIdFromWikidata(parsed.gameName) || "";
    if (fromWiki) { appid = fromWiki; appidSource = "维基百科"; }
  }
  if (!appid) {
    const fromBaike = (en && await deps.fetchAppIdFromBaiduBaike(en))
      || await deps.fetchAppIdFromBaiduBaike(parsed.gameName) || "";
    if (fromBaike) { appid = fromBaike; appidSource = "百度百科"; }
  }
  if (!appid) {
    const fromWeb = (en && await deps.fetchAppIdFromWebSearch(en))
      || await deps.fetchAppIdFromWebSearch(parsed.gameName) || "";
    if (fromWeb) { appid = fromWeb; appidSource = "网页搜索"; }
  }
  if (appid) ok({ name: "Steam AppID", appid, source: appidSource });
  else skip({ name: "Steam AppID", reason: "未找到（英文名/中文名 在 Steam 搜索、维基百科、百度百科、网页搜索均未匹配）" });

  // 3. 游戏介绍：Steam 官方描述作主源（质量最高、零编造），无则占位 + 待校对
  //    （百炼 bl CLI 已移除，不再有 AI 生成兜底；介绍来源收敛为 Steam 官方 / 占位）
  doing({ name: "游戏介绍生成" });
  // 3.1 Steam 官方 store 描述（仅 appid 命中时尝试；失败不致命）
  let steamDesc = "";
  let steamSize = "";
  let steamHeaderImage = "";
  if (appid) {
    try {
      const det = await deps.getSteamAppDetails(appid);
      steamDesc = (det && det.shortDescription) || "";
      steamSize = (det && det.size) || "";
      steamHeaderImage = (det && det.headerImage) || "";
    } catch (_) { /* Steam 详情失败不致命 */ }
  }
  // 3.2 选择介绍主源 + 溯源（provenance）——中文优先：Steam 描述须为中文才采用；
  //     否则走维基百科中文词条首段；均无中文才占位待人工（用户只收中文介绍）。
  let desc = "";
  let introProvenance = "";
  const steamOk = !!(steamDesc && !isBadIntro(steamDesc));
  if (steamOk && isChineseText(steamDesc)) {
    desc = steamDesc;
    introProvenance = "Steam官方";
    ok({ name: "游戏介绍生成（Steam 官方）", desc });
  } else {
    // 兜底：维基百科中文词条首段（Steam 描述不可达或非中文时）
    const wiki = await deps.fetchWikiIntro(en, parsed.gameName);
    if (wiki && wiki.text && wiki.source === "zh" && isChineseText(wiki.text)) {
      desc = wiki.text;
      introProvenance = "维基百科";
      ok({ name: "游戏介绍生成（维基百科）", desc });
    } else {
      // 兜底占位（非标题、非免责声明），显式标注待人工校对，而非静默空
      desc = "介绍待补充";
      introProvenance = "占位";
      skip({
        name: "游戏介绍生成",
        reason: steamOk ? "Steam 仅英文描述且维基无中文词条，已占位待人工补充" : "Steam 无官方描述，已占位待人工补充",
      });
    }
  }

  // 4. 下载封面（优先级：Steam 官方 CDN → 手动链接 → 留空）
  let coverPath = null;
  let coverAttemptFailed = false; // 封面下载真实报错(区别于合理留空)，供最终 coverStatus 判定
  // 4.1 Steam 官方 CDN（已有 appid 时）
  if (!coverPath && appid) {
    doing({ name: "下载 Steam 封面" });
    try {
      // 优先用 appdetails 给的官方图直链（新游戏封面路径带 hash，旧 CDN 规律路径会 404）
      coverPath = await deps.downloadCover(parsed.gameName || parsed.raw, appid, coverDir, { imageUrl: steamHeaderImage });
      const s = deps.fs.statSync(coverPath);
      ok({ name: "封面下载（Steam 官方）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
    } catch (e) { coverAttemptFailed = true; warn({ name: "封面下载（Steam 官方）", reason: e.message }); }
  }
  // 4.2 手动链接兜底
  if (!coverPath && manualCoverUrl) {
    doing({ name: "下载手动封面" });
    try {
      coverPath = await deps.downloadCoverFromUrl(parsed.gameName, manualCoverUrl, coverDir);
      const s = deps.fs.statSync(coverPath);
      ok({ name: "封面下载（手动链接）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
    } catch (e) { coverAttemptFailed = true; warn({ name: "封面下载（手动链接）", reason: e.message }); }
  }
  if (!coverPath) { doing({ name: "封面下载" }); skip({ name: "封面下载", reason: "Steam 无匹配且无手动链接，留空" }); }
  // 交给云库线路复用（避免同一次录入把同一张封面下载两遍）
  shared.coverPath = coverPath || "";

  // 5. 上传附件（失败自动重试 1 次，瞬错常见；仍失败则标记 coverLost 供前端补传）
  let objectId = null;
  if (coverPath) {
    doing({ name: "上传附件" });
    const up = await tryUploadAttachment(deps, coverPath, parsed, 2);
    objectId = up.objectId;
    if (objectId) ok({ name: "附件上传", objectId });
    else fail({ name: "附件上传", error: up.error });
  }

  // 5.5 游戏大小：网盘真实分享页大小抓取已移除（夸克/百度/迅雷均依赖登录态，长期 0 命中率，
  // 只是堆出 3 条「跳过」噪音，不产生任何数据）。统一由 Steam 官方 pc_requirements Storage 兜底 →
  // 仍无则文本识别 → 全无则留空 + 待核。
  // 边界：此改动只移除"获取大小"路径，绝不动网盘链接写入记录 / mcporter 转存中转 / 链接解析 / UI 输入。
  const realSizes = {}; // { steam: "40G" }
  if (steamSize) {
    doing({ name: "Steam 官方大小抓取" });
    realSizes.steam = steamSize;
    ok({ name: "Steam 官方大小", size: steamSize });
  }

  // 6. 创建记录
  doing({ name: "创建多维表记录" });
  // 游戏大小优先级：Steam 官方（pc_requirements Storage）→ 文本识别 → 全无则留空 + 待核
  const gameSize = resolveGameSize(realSizes, parsed.size);
  // 云库线路复用的数据（大小/介绍/分类标签），与金山写入的内容保持一致
  shared.gameSize = gameSize || "";
  shared.desc = desc || "";
  shared.classificationTags = classificationTags === undefined ? DEFAULT_CLASSIFICATION_TAGS : classificationTags;
  const sizeProvenance = realSizes.steam ? "Steam官方"
    : parsed.size ? "文本识别"
    : "待核";
  // 需要人工校对：介绍是占位，或大小全来源缺失
  const needsReview = introProvenance === "占位" || !gameSize;
  const coverSize = (objectId && coverPath) ? deps.fs.statSync(coverPath).size : 0;
  const fields = buildRecordFields(parsed, { desc, coverPath, objectId, gameSize, coverSize, needsReview, introProvenance, sizeProvenance, classificationTags });

  let recordId = null;
  try {
    const createRes = await deps.callMcporter("dbsheet.create_records", { sheet_id: 1, records: [{ fields }] });
    recordId = createRes?.data?.detail?.records?.[0]?.id || createRes?.data?.records?.[0]?.id;
    if (recordId) ok({ name: "创建记录", recordId });
    else fail({ name: "创建记录", error: JSON.stringify(createRes) });
  } catch (e) { fail({ name: "创建记录", error: e.message }); }

  // 7. 验证
  if (recordId) {
    doing({ name: "验证记录" });
    try {
      await deps.callMcporter("dbsheet.get_record", { sheet_id: 1, record_id: recordId });
      ok({ name: "验证通过" });
    } catch (e) { skip({ name: "验证", reason: e.message }); }
  }

  // 封面状态：ok=已获取并上传；absent=合理留空(无来源)；failed=尝试过但报错/上传失败
  let coverStatus;
  if (objectId) coverStatus = "ok";
  else if (coverPath) coverStatus = "failed";            // 下载成功但上传失败（可补传）
  else if (coverAttemptFailed) coverStatus = "failed";   // 下载真实报错
  else coverStatus = "absent";                           // 无来源，合理留空
  const coverLost = !!coverPath && !objectId;            // 已下载但上传失败，本地封面可补传
  // 「警告」不拉红整体（封面是尽力而为），但前端会据此显式提示，不再假装全成功
  const success = steps.every(s => s.status === "成功" || s.status === "跳过" || s.status === "警告");
  const result = {
    steps, recordId, success, action: "created", gameName: parsed.raw,
    coverStatus, coverLost,
    coverPath: coverLost ? coverPath : null, // 仅当可补传时回传本地路径，供「仅重传封面」使用
    needsReview, introProvenance, sizeProvenance, // 数据溯源：介绍/大小来源与是否待人工校对
  };
  return result;
}

// ── 云库线路（独立执行，失败不拉红金山）──
// 只做「查重 → 入库 → 补封面」三件事；任何异常都被收拢成 { ok:false, error } 返回，
// 绝不 throw 给上层（否则会中断金山那条线路）。
async function runCloudLine(parsed, shared, opts, deps) {
  const steps = [];
  let stepIdx = -1;
  const emitRaw = typeof opts.onStep === "function" ? opts.onStep : () => {};
  const emit = (ev) => emitRaw({ ...ev, group: "cloud" });
  const setStatus = (s, status) => {
    steps[stepIdx] = { ...s, status };
    emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } });
  };
  const ok = (s) => setStatus(s, "成功");
  const skip = (s) => setStatus(s, "跳过");
  const fail = (s) => setStatus(s, "失败");
  const warn = (s) => setStatus(s, "警告");
  const doing = (s) => { stepIdx = steps.length; steps.push({ ...s, status: "进行中" }); emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };

  const cloud = deps.cloud;
  const manualCoverUrl = (opts.manualCoverUrl || "").trim();
  const coverDir = opts.coverDir;

  // 0. 配置检查：密码没配就直接跳过整条线路（不是失败，用户只要补配置即可）
  doing({ name: "检查云库配置" });
  try {
    if (!cloud.hasCredentials(opts.cloudOpts || {})) {
      skip({
        name: "云库配置",
        reason: "未配置后台密码（环境变量 QQBOT_ADMIN_PASSWORD），云库线路已跳过",
      });
      return { ok: false, skipped: true, action: "no_password", steps, error: "未配置云库后台密码" };
    }
    ok({ name: "云库配置" });
  } catch (e) {
    fail({ name: "云库配置", error: e.message });
    return { ok: false, skipped: false, action: "config_failed", steps, error: e.message };
  }

  // 1. 登录（token 有缓存，401 会在客户端内部重登一次）
  doing({ name: "云库登录" });
  let token = "";
  try {
    token = await cloud.getToken(opts.cloudOpts || {});
    ok({ name: "云库登录" });
  } catch (e) {
    fail({ name: "云库登录", error: e.message });
    return { ok: false, skipped: false, action: "signin_failed", steps, error: e.message };
  }

  // 2. 查重（p_status 在客户端内硬编码 all；命中也只能跳过 —— 云库没有更新接口）
  doing({ name: "云库查重" });
  let dupRow = null;
  try {
    dupRow = await cloud.findDup(parsed.raw, opts.cloudOpts || {});
    if (dupRow) ok({ name: "云库查重命中", recordId: dupRow.id });
    else ok({ name: "云库查重通过（无重复）" });
  } catch (e) {
    warn({ name: "云库查重", reason: e.message });
  }
  if (dupRow) {
    return { ok: true, skipped: true, action: "skipped", id: dupRow.id, steps };
  }

  // 3. 组装 p_row（字段映射：名称/大小/标签/日期/三家网盘）
  //    金山线路可能提前返回（命重跳过）或压根没跑（只勾云库），此时 shared 里没有值，
  //    这里按与金山一致的规则兜底，保证两条线路写进去的字段口径相同。
  const fallbackTags = Array.isArray(opts.classificationTags)
    ? opts.classificationTags.filter((t) => typeof t === "string" && t.trim())
    : DEFAULT_CLASSIFICATION_TAGS;
  const row = cloud.buildRow(parsed, {
    gameSize: shared.gameSize || resolveGameSize({}, parsed.size) || "",
    tags: shared.classificationTags === undefined ? fallbackTags : shared.classificationTags,
    intro: shared.desc && shared.desc !== "介绍待补充" ? shared.desc : "",
  });

  // 4. 入库（p_id=null，只增）
  doing({ name: "云库入库" });
  let newId = null;
  try {
    const res = await cloud.insert(row, opts.cloudOpts || {});
    newId = res.id;
    ok({ name: "云库入库", recordId: newId });
  } catch (e) {
    fail({ name: "云库入库", error: e.message });
    return { ok: false, skipped: false, action: "insert_failed", steps, error: e.message };
  }

  // 5. 封面（可选，尽力而为）：来源优先级 = 金山已下的封面 → 手动链接 → 自己去 Steam 搜
  //    金山线路若已给出「有没有封面」的结论（跑了但没找到会给空串），这里就不再重复联网搜 Steam；
  //    只有金山压根没产出结论时才自己找 —— 覆盖「只勾云库」和「金山命重提前跳过」两种情况。
  let coverPath = shared.coverPath || "";
  const kdocsResolvedCover = shared.coverPath !== undefined;
  let coverSourceReported = false; // 封面来源那一步是否已自行给出失败结论（避免再补一条重复的「跳过」）
  if (!coverPath && manualCoverUrl) {
    doing({ name: "云库补封面（手动链接）" });
    coverSourceReported = true;
    try {
      coverPath = await deps.downloadCoverFromUrl(parsed.gameName, manualCoverUrl, coverDir);
      ok({ name: "云库补封面（手动链接）", path: coverPath });
    } catch (e) { coverPath = ""; warn({ name: "云库补封面（手动链接）", reason: e.message }); }
  }
  // 5.1 自己搜 Steam：AppID → appdetails 官方图直链 → 落盘。
  //     口径与金山线路一致（新游戏封面路径带 hash，只靠 CDN 规律路径会 404）。
  if (!coverPath && !manualCoverUrl && !kdocsResolvedCover) {
    doing({ name: "云库取封面（Steam）" });
    coverSourceReported = true;
    try {
      const appid = await deps.searchSteamAppId(parsed.gameName);
      if (!appid) {
        warn({ name: "云库取封面（Steam）", reason: "未匹配到 Steam AppID" });
      } else {
        let imageUrl = "";
        try {
          const det = await deps.getSteamAppDetails(appid);
          imageUrl = (det && det.headerImage) || "";
        } catch { /* appdetails 失败不致命，退回 CDN 规律路径 */ }
        coverPath = await deps.downloadCover(parsed.gameName || parsed.raw, appid, coverDir, { imageUrl });
        ok({ name: "云库取封面（Steam）", appid, path: coverPath });
      }
    } catch (e) { coverPath = ""; warn({ name: "云库取封面（Steam）", reason: e.message }); }
  }
  if (coverPath) {
    doing({ name: "云库传封面" });
    try {
      await cloud.setCover(newId, coverPath, opts.cloudOpts || {});
      ok({ name: "云库传封面", path: coverPath });
    } catch (e) {
      warn({ name: "云库传封面", reason: e.message });
    }
  } else if (!coverSourceReported) {
    // 明确告知：记录已建但没封面，去后台页补
    doing({ name: "云库传封面" });
    skip({ name: "云库传封面", reason: "无可用封面图，可稍后在后台页补传" });
  }

  return { ok: true, skipped: false, action: "created", id: newId, steps, coverOk: !!coverPath };
}

// ── 对外入口：按 targets 编排两条独立线路 ──
async function autoExecute(parsed, manualAppId, coverDir, opts = {}) {
  const deps = { ...DEFAULT_DEPS, ...(opts.deps || {}) };
  const targets = resolveTargets(opts.targets);
  const emitRaw = typeof opts.onStep === "function" ? opts.onStep : () => {};
  // shared：金山线路跑完后把「已下载的封面 / 大小 / 介绍 / 标签」留给云库线路复用，避免重复下载
  const shared = {};

  let kdocsResult = null;
  if (targets.kdocs) {
    kdocsResult = await autoExecuteKdocs(parsed, manualAppId, coverDir, opts, shared);
  }

  let cloudResult = null;
  if (targets.cloud) {
    try {
      cloudResult = await runCloudLine(parsed, shared, { ...opts, coverDir }, deps);
    } catch (e) {
      // 兜底：云库线路内部已 try/catch，这里再兜一层，确保任何意外都不会影响金山结果
      cloudResult = { ok: false, skipped: false, action: "internal_error", steps: [], error: e.message };
    }
  }

  // 合并结果：success 只由金山线路决定（云库失败不拉红整体，由前端单独展示）
  const result = kdocsResult || {
    steps: [], recordId: null, success: true, action: "cloud_only", gameName: parsed.raw,
  };
  if (cloudResult) result.cloud = cloudResult;
  if (!targets.kdocs) result.success = !!(cloudResult && cloudResult.ok);
  result.targets = targets;
  emitRaw({ type: "done", result });
  return result;
}

// ── 纯函数（不依赖外部 IO，可单测）──
// 游戏大小优先级：Steam 官方（pc_requirements Storage）→ 文本识别 → 全无则空。
// 网盘真实分享页大小已移除（夸克/百度/迅雷 均依赖登录态，长期 0 命中率）。
// 所有候选均经 normalizeSize 统一为短格式（"30.7GB"→"30.7G"，规范文档 §2.5）。
function resolveGameSize(realSizes = {}, parsedSize = "") {
  const steam = normalizeSize(realSizes.steam);
  if (steam) return steam;
  return normalizeSize(parsedSize) || "";
}

// 组装多维表字段（封面对象仅当 objectId+coverPath 都存在时附带）
// 游戏信息 = 仅用户勾选的分类标签（classificationTags）。出于用户要求「我勾选好的是什么就是什么，不能再有别的」，
//   不再自动并入 parser 从文本关键词检测的标签（免安装/全DLC/虚拟机/联机合作/PC游戏），也不再自动加来源/校对标记。
//   classificationTags（默认 DEFAULT_CLASSIFICATION_TAGS 兜底）：undefined → 用默认；空数组 → 用户显式清空。
function buildRecordFields(parsed, { desc, coverPath, objectId, gameSize, coverSize, needsReview, introProvenance, sizeProvenance, classificationTags }) {
  // 分类标签放最前面（用户期望在「游戏信息」列表里最显眼）；用 Set 保序去重
  const seen = new Set();
  const tags = [];
  const push = (t) => { if (t && !seen.has(t)) { seen.add(t); tags.push(t); } };
  // 仅当传了 classificationTags 时才覆盖默认（保留 undefined → 默认；空数组 → 真清空 的语义）
  const cls = classificationTags === undefined ? DEFAULT_CLASSIFICATION_TAGS : classificationTags;
  (cls || []).forEach(push);
  // 注意：游戏信息严格等于用户勾选，不再合并 parsed.tags（文本关键词自动检测）与来源/校对标记。
  const fields = {
    游戏名称: parsed.raw, // 第一行原样，不清洗；查重也比对 parsed.raw（稳定一致）
    游戏介绍: desc || parsed.raw,
    游戏信息: tags,
    更新日期: new Date().toISOString().split("T")[0].replace(/-/g, "/"),
  };
  if (gameSize) fields["游戏大小"] = gameSize;
  if (parsed.baiduUrl) fields["百度网盘"] = [{ address: parsed.baiduUrl, displayText: parsed.baiduUrl }];
  if (parsed.quarkUrl) fields["夸克网盘"] = [{ address: parsed.quarkUrl, displayText: parsed.quarkUrl }];
  if (parsed.xunleiUrl) fields["迅雷网盘"] = [{ address: parsed.xunleiUrl, displayText: parsed.xunleiUrl }];
  if (objectId && coverPath) {
    const ext = path.extname(coverPath).slice(1).toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    fields["作品展示"] = [{ fileName: `${parsed.gameName}_cover.${ext}`, size: coverSize, source: "upload_ks3", type: mime, uploadId: objectId }];
  }
  return fields;
}

// ── 附件上传（带重试）：瞬错常见，失败自动重试 attempts-1 次 ──
async function tryUploadAttachment(deps, coverPath, parsed, attempts = 2) {
  const ext = path.extname(coverPath).slice(1).toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const uploadRes = await deps.callMcporter("upload_attachment", {
        sheet_id: 1,
        filename: `${parsed.gameName}_cover.${ext}`,
        content_type: mime,
        content_base64: deps.fileBase64(coverPath),
      });
      const oid = uploadRes?.object_id || uploadRes?.data?.object_id;
      if (oid) return { objectId: oid };
      lastErr = "未返回 object_id：" + JSON.stringify(uploadRes);
    } catch (e) { lastErr = e.message; }
  }
  return { objectId: null, error: lastErr };
}

// ── 「仅重传封面」补救（P0-3）：对已存在记录补传封面附件并写入 作品展示 字段 ──
async function retryCoverUpload(recordId, coverPath, opts = {}) {
  const deps = { ...DEFAULT_DEPS, ...(opts.deps || {}) };
  const emit = typeof opts.onStep === "function" ? opts.onStep : () => {};
  const steps = [];
  let stepIdx = -1;
  const ok = (s) => { steps[stepIdx] = { ...s, status: "成功" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const fail = (s) => { steps[stepIdx] = { ...s, status: "失败" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const doing = (s) => { stepIdx = steps.length; steps.push({ ...s, status: "进行中" }); emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };

  if (!recordId || !coverPath) return { success: false, error: "缺少 recordId 或 coverPath", steps };
  let objectId = null;
  doing({ name: "重传封面附件" });
  try {
    const up = await tryUploadAttachment(deps, coverPath, { gameName: "cover" }, 2);
    objectId = up.objectId;
    if (objectId) ok({ name: "重传封面附件", objectId });
    else { fail({ name: "重传封面附件", error: up.error }); return { success: false, objectId: null, steps }; }
  } catch (e) { fail({ name: "重传封面附件", error: e.message }); return { success: false, objectId: null, steps }; }

  doing({ name: "更新记录封面字段" });
  try {
    const ext = path.extname(coverPath).slice(1).toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const size = deps.fs.statSync(coverPath).size;
    await deps.callMcporter("dbsheet.update_records", {
      sheet_id: 1,
      records: [{ id: recordId, fields: { "作品展示": [{ fileName: `cover.${ext}`, size, source: "upload_ks3", type: mime, uploadId: objectId }] } }],
    });
    ok({ name: "更新记录封面字段" });
  } catch (e) { fail({ name: "更新记录封面字段", error: e.message }); return { success: false, objectId, steps }; }

  return { success: true, objectId, steps };
}

module.exports = { autoExecute, autoExecuteKdocs, runCloudLine, resolveTargets, findExistingRecord, DEFAULT_DEPS, DEFAULT_CLASSIFICATION_TAGS, buildRecordFields, resolveGameSize, tryUploadAttachment, retryCoverUpload };
