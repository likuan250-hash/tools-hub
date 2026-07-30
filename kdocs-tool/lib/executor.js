// ── 一键执行编排 ──
const fs = require("fs");
const path = require("path");
const steam = require("./steam");
const kdocs = require("./kdocs");
const ai = require("./ai");
const quark = require("./quark");
const { isBadIntro } = require("./constants");

// 默认依赖（真实实现）；测试可通过 opts.deps 覆盖任意项注入 mock
const DEFAULT_DEPS = {
  fs,
  searchSteamAppId: steam.searchSteamAppId,
  downloadCover: steam.downloadCover,
  downloadCoverFromUrl: steam.downloadCoverFromUrl,
  callMcporter: kdocs.callMcporter,
  checkKdocsReady: kdocs.checkKdocsReady,
  fileBase64: kdocs.fileBase64,
  aiDescribe: ai.aiDescribe,
  aiCoverSearch: ai.aiCoverSearch,
  getTotalSize: quark.getTotalSize,
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
  const steps = [];
  let stepIdx = -1;
  // onStep 实时回调（SSE 流式进度用）；不传则无副作用（保持测试兼容）
  const emit = typeof opts.onStep === "function" ? opts.onStep : () => {};
  const ok = (s) => { steps[stepIdx] = { ...s, status: "成功" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const skip = (s) => { steps[stepIdx] = { ...s, status: "跳过" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
  const fail = (s) => { steps[stepIdx] = { ...s, status: "失败" }; emit({ type: "step", step: { index: stepIdx, ...steps[stepIdx] } }); };
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

  // 2. 搜索 Steam AppID（中英文名各搜一次，提高命中率）
  let appid = manualAppId || null;
  if (!appid) {
    doing({ name: "搜索 Steam AppID" });
    appid = await deps.searchSteamAppId(parsed.gameName);
    if (!appid && parsed.englishName) appid = await deps.searchSteamAppId(parsed.englishName);
    if (appid) ok({ name: "Steam AppID", appid });
    else skip({ name: "Steam AppID", reason: "未找到（非 Steam 或名称无匹配）" });
  } else {
    ok({ name: "Steam AppID", appid });
  }

  // 3. 游戏介绍与大小：bl 即内置 agent，负责联网搜真实介绍 + 抓大小（含夸克/百度分享页）
  doing({ name: "游戏介绍与大小（bl）" });
  const aiRes = await deps.aiDescribe(parsed.gameName, parsed.raw, {
    quarkUrl: parsed.quarkUrl,
    baiduUrl: parsed.baiduUrl,
    xunleiUrl: parsed.xunleiUrl,
    englishName: parsed.englishName,
  });
  // 内容质量校验：丢弃免责声明
  let desc = aiRes.intro;
  if (desc && !isBadIntro(desc)) ok({ name: "游戏介绍生成", desc });
  else { skip({ name: "游戏介绍生成", reason: "bl 未返回有效介绍或含免责声明" }); desc = parsed.raw; }

  // 4. 下载封面（优先级：Steam 官方 CDN → bl 联网搜真实封面(中英文双搜+下载校验) → 手动链接 → 留空）
  let coverPath = null;
  // 4.1 Steam 官方 CDN（已有 appid 时）
  if (!coverPath && appid) {
    doing({ name: "下载 Steam 封面" });
    try {
      coverPath = await deps.downloadCover(parsed.gameName, appid, coverDir);
      const s = deps.fs.statSync(coverPath);
      ok({ name: "封面下载（Steam 官方）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
    } catch (e) { skip({ name: "封面下载（Steam 官方）", reason: e.message }); }
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
    } catch (e) { skip({ name: "封面下载（bl 联网搜索）", reason: e.message }); }
  }
  // 4.3 手动链接兜底
  if (!coverPath && manualCoverUrl) {
    doing({ name: "下载手动封面" });
    try {
      coverPath = await deps.downloadCoverFromUrl(parsed.gameName, manualCoverUrl, coverDir);
      const s = deps.fs.statSync(coverPath);
      ok({ name: "封面下载（手动链接）", path: coverPath, size: (s.size / 1024).toFixed(0) + "KB" });
    } catch (e) { skip({ name: "封面下载（手动链接）", reason: e.message }); }
  }
  if (!coverPath) { doing({ name: "封面下载" }); skip({ name: "封面下载", reason: "Steam 无匹配、bl 未搜到、且无手动链接，留空" }); }

  // 5. 上传附件
  let objectId = null;
  if (coverPath) {
    doing({ name: "上传附件" });
    try {
      const b64 = deps.fileBase64(coverPath);
      const ext = path.extname(coverPath).slice(1).toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const uploadRes = await deps.callMcporter("upload_attachment", {
        sheet_id: 1,
        filename: `${parsed.gameName}_cover.${ext}`,
        content_type: mime,
        content_base64: b64,
      });
      objectId = uploadRes?.object_id || uploadRes?.data?.object_id;
      if (objectId) ok({ name: "附件上传", objectId });
      else fail({ name: "附件上传", error: JSON.stringify(uploadRes) });
    } catch (e) { fail({ name: "附件上传", error: e.message }); }
  }

  // 5.5 夸克分享页总大小（真实字节求和，按版本号取最新版）：有夸克链接即优先抓取，失败才回退文本/留空
  let quarkSize = "";
  if (parsed.quarkUrl) {
    doing({ name: "夸克分享页大小抓取" });
    try {
      const r = await deps.getTotalSize(parsed.quarkUrl);
      if (r && r.text && r.bytes > 0) {
        quarkSize = r.text;
        ok({ name: "夸克分享页大小", size: r.text, files: r.files });
      } else {
        skip({ name: "夸克分享页大小", reason: "未获取到有效大小（分享为空或未配置夸克登录）" });
      }
    } catch (e) {
      skip({ name: "夸克分享页大小", reason: e.message });
    }
  }

  // 6. 创建记录
  doing({ name: "创建多维表记录" });
  // 游戏大小：夸克真实求和优先（准确），其次 bl 简介附带，再次文本识别
  const gameSize = resolveGameSize(quarkSize, aiRes.size, parsed.size);
  const coverSize = (objectId && coverPath) ? deps.fs.statSync(coverPath).size : 0;
  const fields = buildRecordFields(parsed, { desc, coverPath, objectId, gameSize, coverSize });

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

  const success = steps.every(s => s.status === "成功" || s.status === "跳过");
  const result = { steps, recordId, success, action: "created", gameName: parsed.gameName };
  emit({ type: "done", result });
  return result;
}

// ── 纯函数（不依赖外部 IO，可单测）──
// 游戏大小优先级：夸克真实求和 > bl 简介附带 > 文本识别 > 空
function resolveGameSize(quarkSize, aiSize, parsedSize) {
  return quarkSize || aiSize || parsedSize || "";
}

// 组装多维表字段（封面对象仅当 objectId+coverPath 都存在时附带）
function buildRecordFields(parsed, { desc, coverPath, objectId, gameSize, coverSize }) {
  const fields = {
    游戏名称: parsed.raw,
    游戏介绍: desc || parsed.raw,
    游戏信息: parsed.tags,
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

module.exports = { autoExecute, findExistingRecord, DEFAULT_DEPS, buildRecordFields, resolveGameSize };
