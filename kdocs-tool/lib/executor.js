// ── 一键执行编排 ──
const fs = require("fs");
const path = require("path");
const steam = require("./steam");
const kdocs = require("./kdocs");
const ai = require("./ai");
const quark = require("./quark");
const { isBadIntro, normalizeSize } = require("./constants");

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
  downloadCover: steam.downloadCover,
  downloadCoverFromUrl: steam.downloadCoverFromUrl,
  callMcporter: kdocs.callMcporter,
  checkKdocsReady: kdocs.checkKdocsReady,
  fileBase64: kdocs.fileBase64,
  aiDescribe: ai.aiDescribe,
  aiCoverSearch: ai.aiCoverSearch,
};

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

async function autoExecute(parsed, manualAppId, coverDir, opts = {}) {
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
  const emit = typeof opts.onStep === "function" ? opts.onStep : () => {};
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
    const result = { steps, recordId: null, success: false, action: "failed", gameName: parsed.gameName };
    emit({ type: "done", result });
    return result;
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
      const result = { steps, recordId: dup.recordId, success: true, action: "skipped", gameName: parsed.gameName };
      emit({ type: "done", result });
      return result;
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
      const result = { steps, recordId: dup.recordId, success: true, action: "updated", gameName: parsed.gameName };
      emit({ type: "done", result });
      return result;
    } catch (e) {
      fail({ name: "更新网盘链接", error: e.message });
      const result = { steps, recordId: dup.recordId, success: false, action: "update_failed", gameName: parsed.gameName };
      emit({ type: "done", result });
      return result;
    }
  } else {
    // 默认：已存在则跳过，不创建不改写
    ok({ name: "查重命中，已存在（跳过）", recordId: dup.recordId });
    const result = { steps, recordId: dup.recordId, success: true, action: "skipped", gameName: parsed.gameName };
    emit({ type: "done", result });
    return result;
  }

  // 2. 取拿 Steam AppID（多源兜底：手动录入 → Steam 搜索 → 维基百科 → 百度百科 → 网页搜索）
  //    拿到 AppID 后即可统一兜底封面 / 游戏简介 / 游戏大小（Steam 官方数据最稳）。
  let appid = manualAppId || null;
  let appidSource = manualAppId ? "手动录入" : "";
  doing({ name: "搜索 Steam AppID" });
  if (!appid) {
    appid = await deps.searchSteamAppId(parsed.gameName);
    if (!appid && parsed.englishName) appid = await deps.searchSteamAppId(parsed.englishName);
    if (appid) appidSource = "Steam 搜索";
  }
  if (!appid) {
    const fromWiki = (await deps.fetchAppIdFromWikidata(parsed.gameName))
      || (parsed.englishName && await deps.fetchAppIdFromWikidata(parsed.englishName)) || "";
    if (fromWiki) { appid = fromWiki; appidSource = "维基百科"; }
  }
  if (!appid) {
    const fromBaike = (await deps.fetchAppIdFromBaiduBaike(parsed.gameName))
      || (parsed.englishName && await deps.fetchAppIdFromBaiduBaike(parsed.englishName)) || "";
    if (fromBaike) { appid = fromBaike; appidSource = "百度百科"; }
  }
  if (!appid) {
    const fromWeb = (await deps.fetchAppIdFromWebSearch(parsed.gameName))
      || (parsed.englishName && await deps.fetchAppIdFromWebSearch(parsed.englishName)) || "";
    if (fromWeb) { appid = fromWeb; appidSource = "网页搜索"; }
  }
  if (appid) ok({ name: "Steam AppID", appid, source: appidSource });
  else skip({ name: "Steam AppID", reason: "未找到（Steam 搜索、维基百科、百度百科、网页搜索均未匹配）" });

  // 3. 游戏介绍：Steam 官方描述作主源（质量最高、零编造），bl 降次级，双无则占位 + 待校对
  doing({ name: "游戏介绍与大小（bl 辅助）" });
  // 3.1 Steam 官方 store 描述（仅 appid 命中时尝试；失败不致命，交由 bl 兜底）
  let steamDesc = "";
  let steamSize = "";
  if (appid) {
    try {
      const det = await deps.getSteamAppDetails(appid);
      steamDesc = (det && det.shortDescription) || "";
      steamSize = (det && det.size) || "";
    } catch (_) { /* Steam 详情失败不致命 */ }
  }
  // 3.2 bl 生成（介绍 + 大小猜测），作为次级源 / 大小兜底
  const aiRes = await deps.aiDescribe(parsed.gameName, parsed.raw, {
    quarkUrl: parsed.quarkUrl,
    baiduUrl: parsed.baiduUrl,
    xunleiUrl: parsed.xunleiUrl,
    englishName: parsed.englishName,
  });
  // 3.3 选择介绍主源 + 溯源（provenance）
  let desc = "";
  let introProvenance = "";
  if (steamDesc && !isBadIntro(steamDesc)) {
    desc = steamDesc;
    introProvenance = "Steam官方";
    ok({ name: "游戏介绍生成（Steam 官方）", desc });
  } else if (aiRes.intro && !isBadIntro(aiRes.intro)) {
    desc = aiRes.intro;
    introProvenance = "bl联网";
    ok({ name: "游戏介绍生成（bl）", desc });
  } else {
    // 兜底占位（非标题、非免责声明），显式标注待人工校对，而非静默空
    desc = "介绍待补充";
    introProvenance = "占位";
    skip({ name: "游戏介绍生成", reason: "Steam 无官方描述且 bl 未返回有效介绍，已占位待人工补充" });
  }

  // 4. 下载封面（优先级：Steam 官方 CDN → bl 联网搜真实封面(中英文双搜+下载校验) → 手动链接 → 留空）
  let coverPath = null;
  let coverAttemptFailed = false; // 封面下载真实报错(区别于合理留空)，供最终 coverStatus 判定
  // 4.1 Steam 官方 CDN（已有 appid 时）
  if (!coverPath && appid) {
    doing({ name: "下载 Steam 封面" });
    try {
      coverPath = await deps.downloadCover(parsed.gameName, appid, coverDir);
      const s = deps.fs.statSync(coverPath);
      ok({ name: "封面下载（Steam 官方）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
    } catch (e) { coverAttemptFailed = true; warn({ name: "封面下载（Steam 官方）", reason: e.message }); }
  }
  // 4.2 bl 联网搜真实封面（中英文名各搜一次，downloadCoverFromUrl 做真实下载校验防破图）
  if (!coverPath && deps.aiCoverSearch) {
    doing({ name: "bl 联网搜索封面（中英文）" });
    try {
      const url = await deps.aiCoverSearch(parsed.gameName, parsed.englishName);
      if (url) {
        coverPath = await deps.downloadCoverFromUrl(parsed.gameName, url, coverDir);
        const s = deps.fs.statSync(coverPath);
        ok({ name: "封面下载（bl 联网搜索）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
      } else {
        skip({ name: "封面下载（bl 联网搜索）", reason: "未搜到可用封面直链" });
      }
    } catch (e) { coverAttemptFailed = true; warn({ name: "封面下载（bl 联网搜索）", reason: e.message }); }
  }
  // 4.3 手动链接兜底
  if (!coverPath && manualCoverUrl) {
    doing({ name: "下载手动封面" });
    try {
      coverPath = await deps.downloadCoverFromUrl(parsed.gameName, manualCoverUrl, coverDir);
      const s = deps.fs.statSync(coverPath);
      ok({ name: "封面下载（手动链接）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
    } catch (e) { coverAttemptFailed = true; warn({ name: "封面下载（手动链接）", reason: e.message }); }
  }
  if (!coverPath) { doing({ name: "封面下载" }); skip({ name: "封面下载", reason: "Steam 无匹配、bl 未搜到、且无手动链接，留空" }); }

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
  // 仍无则走 bl 简介附带 → 仍无则文本识别 → 全无则留空 + 待核。
  // 边界：此改动只移除"获取大小"路径，绝不动网盘链接写入记录 / mcporter 转存中转 / 链接解析 / UI 输入。
  const realSizes = {}; // { steam: "40G" }
  if (steamSize) {
    doing({ name: "Steam 官方大小抓取" });
    realSizes.steam = steamSize;
    ok({ name: "Steam 官方大小", size: steamSize });
  }

  // 6. 创建记录
  doing({ name: "创建多维表记录" });
  // 游戏大小优先级：Steam 官方（pc_requirements Storage）→ bl 简介附带 → 文本识别 → 全无则留空 + 待核
  const gameSize = resolveGameSize(realSizes, aiRes.size, parsed.size);
  const sizeProvenance = realSizes.steam ? "Steam官方"
    : aiRes.size ? "bl猜测"
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
    steps, recordId, success, action: "created", gameName: parsed.gameName,
    coverStatus, coverLost,
    coverPath: coverLost ? coverPath : null, // 仅当可补传时回传本地路径，供「仅重传封面」使用
    needsReview, introProvenance, sizeProvenance, // 数据溯源：介绍/大小来源与是否待人工校对
  };
  emit({ type: "done", result });
  return result;
}

// ── 纯函数（不依赖外部 IO，可单测）──
// 游戏大小优先级：Steam 官方（pc_requirements Storage）→ bl 简介附带 → 文本识别 → 全无则空。
// 网盘真实分享页大小已移除（夸克/百度/迅雷 均依赖登录态，长期 0 命中率），保留调用入口仅为兼容旧 realSizes 结构。
// 所有候选均经 normalizeSize 统一为短格式（"30.7GB"→"30.7G"，规范文档 §2.5）。
function resolveGameSize(realSizes = {}, aiSize = "", parsedSize = "") {
  const steam = normalizeSize(realSizes.steam);
  if (steam) return steam;
  const ai = normalizeSize(aiSize);
  if (ai) return ai;
  return normalizeSize(parsedSize) || "";
}

// 组装多维表字段（封面对象仅当 objectId+coverPath 都存在时附带）
// needsReview / introProvenance / sizeProvenance 写入「游戏信息」标签，让数据来源可追溯、缺失显式标注。
// classificationTags（默认 DEFAULT_CLASSIFICATION_TAGS）：写入记录前部，已存在的标签不重复添加。
//   undefined → 用默认；空数组 → 用户显式清空（不要自动回填）
function buildRecordFields(parsed, { desc, coverPath, objectId, gameSize, coverSize, needsReview, introProvenance, sizeProvenance, classificationTags }) {
  // 分类标签放最前面（用户期望在「游戏信息」列表里最显眼）；用 Set 保序去重
  const seen = new Set();
  const tags = [];
  const push = (t) => { if (t && !seen.has(t)) { seen.add(t); tags.push(t); } };
  // 仅当传了 classificationTags 时才覆盖默认（保留 undefined → 默认；空数组 → 真清空 的语义）
  const cls = classificationTags === undefined ? DEFAULT_CLASSIFICATION_TAGS : classificationTags;
  (cls || []).forEach(push);
  // parser 关键词检测到的（免安装/全DLC/虚拟机/联机合作/PC游戏）与分类标签可能重合，去重交给 Set
  (parsed.tags || []).forEach(push);
  if (introProvenance) push(`介绍:${introProvenance}`);
  if (sizeProvenance) push(`大小:${sizeProvenance}`);
  if (needsReview) push("⚠需人工校对");
  const fields = {
    游戏名称: parsed.raw,
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

module.exports = { autoExecute, findExistingRecord, DEFAULT_DEPS, DEFAULT_CLASSIFICATION_TAGS, buildRecordFields, resolveGameSize, tryUploadAttachment, retryCoverUpload };
