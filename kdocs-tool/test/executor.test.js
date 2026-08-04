// executor.test.js — 编排流程单元测试（注入 fake deps，不依赖外部 CLI）
const test = require("node:test");
const assert = require("node:assert");
const { autoExecute, findExistingRecord, buildRecordFields, resolveGameSize } = require("../lib/executor");

function baseParsed(over = {}) {
  return {
    gameName: "双影奇境", englishName: "Split Fiction",
    baiduUrl: "", quarkUrl: "", xunleiUrl: "",
    tags: ["PC游戏"], raw: "双影奇境（Split Fiction）",
    size: "", coverUrl: "",
    ...over,
  };
}

function baseDeps(over = {}) {
  let lastCreate = null;
  let downloadCoverCount = 0;
  let downloadFromUrlCount = 0;
  let lastUpdate = null;
  const calls = [];
  const listRecords = over.listRecords || [];
  const deps = {
    calls,
    checkKdocsReady: () => true,
    searchSteamAppId: async () => null,
    getSteamAppDetails: async () => null, // 默认无 Steam 官方描述（走占位）
    fetchAppIdFromWikidata: async () => null,
    fetchAppIdFromBaiduBaike: async () => null,
    fetchAppIdFromWebSearch: async () => null,
    resolveEnglishName: async () => "", // 默认解析不到英文名（走中文名匹配）
    downloadCover: async () => { downloadCoverCount++; return "/fake/steam.jpg"; },
    downloadCoverFromUrl: async () => { downloadFromUrlCount++; return "/fake/cover.jpg"; },
    fileBase64: () => "base64data",
    callMcporter: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "upload_attachment") return { object_id: "obj1" };
      if (fn === "dbsheet.list_records") return { data: { detail: { records: listRecords } } };
      if (fn === "dbsheet.create_records") lastCreate = args.records[0].fields;
      if (fn === "dbsheet.update_records") lastUpdate = args.records[0];
      return { data: { records: [{ id: "r1" }] } };
    },
    fs: { statSync: () => ({ size: 1234 }) },
    _state: () => ({ lastCreate, downloadCoverCount, downloadFromUrlCount, calls, lastUpdate }),
    ...over,
  };
  return deps;
}

test("kdocs 未就绪 → 提前失败", async () => {
  const deps = baseDeps({ checkKdocsReady: () => false });
  const res = await autoExecute(baseParsed(), null, "/tmp/cover", { deps });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.steps[0].status, "失败");
  assert.strictEqual(res.recordId, null);
});

test("正常流程字段映射正确（Steam 官方主源）", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ shortDescription: "Hazelight 开发的双人合作冒险游戏。", size: "30.7GB" }),
  });
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp/cover", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(res.recordId, "r1");
  assert.strictEqual(lastCreate["游戏名称"], "双影奇境");
  assert.strictEqual(lastCreate["游戏介绍"], "Hazelight 开发的双人合作冒险游戏。");
  assert.strictEqual(lastCreate["游戏大小"], "30.7G", "大小经归一化：30.7GB → 30.7G");
  assert.strictEqual(lastCreate["夸克网盘"][0].address, "https://pan.quark.cn/s/x");
  assert.strictEqual(res.introProvenance, "Steam官方");
  assert.strictEqual(res.sizeProvenance, "Steam官方");
});

test("游戏大小优先级：Steam 官方 > 文本识别（parsed.size）", async () => {
  // Steam 官方优先
  let deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ shortDescription: "x".repeat(20), size: "10GB" }),
  });
  await autoExecute(baseParsed({ size: "5G" }), null, "/tmp", { deps });
  assert.strictEqual(deps._state().lastCreate["游戏大小"], "10G", "Steam 官方优先且归一化");

  // Steam 无 → 文本识别优先
  deps = baseDeps({ getSteamAppDetails: async () => null });
  await autoExecute(baseParsed({ size: "5G" }), null, "/tmp", { deps });
  assert.strictEqual(deps._state().lastCreate["游戏大小"], "5G", "Steam 无时文本识别优先且归一化");

  // 全空 → 不写字段
  deps = baseDeps({ getSteamAppDetails: async () => null });
  await autoExecute(baseParsed({ size: "" }), null, "/tmp", { deps });
  assert.ok(!("游戏大小" in deps._state().lastCreate), "全空不应写游戏大小字段");
});

test("含免责声明的介绍被丢弃（Steam 官方描述命中黑名单），改为占位「介绍待补充」+ needsReview", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ shortDescription: "该游戏经核实无真实公开资料，疑似虚构，请勿轻信。", size: "" }),
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏介绍"], "介绍待补充", "免责声明应被丢弃并占位，而非用标题兜底");
  assert.strictEqual(res.introProvenance, "占位");
  assert.strictEqual(res.needsReview, true);
  assert.ok(lastCreate["游戏信息"].includes("⚠需人工校对"));
});

test("大小缺失时不再提示手动填写，直接不写入游戏大小字段", async () => {
  const deps = baseDeps({ getSteamAppDetails: async () => null }); // 无 Steam 官方大小 + parsed.size 默认空
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const sizeStep = res.steps.find(s => s.name.includes("大小抓取"));
  assert.strictEqual(sizeStep, undefined, "不应再出现大小抓取步骤");
  assert.ok(!("游戏大小" in deps._state().lastCreate));
  assert.strictEqual(res.success, true, "大小缺失不应导致失败");
});

test("封面优先级：Steam 官方优先，命中即下载并上传", async () => {
  const deps = baseDeps({ searchSteamAppId: async () => "12345" });
  await autoExecute(baseParsed(), "12345", "/tmp", { deps });
  const { downloadCoverCount, lastCreate } = deps._state();
  assert.strictEqual(downloadCoverCount, 1, "有 appid 应走 Steam 官方封面");
  assert.ok(lastCreate["作品展示"] && lastCreate["作品展示"][0].uploadId === "obj1", "Steam 封面应上传为作品展示");
});

// ── H1：解析输入里的 Steam 链接抽到的 AppID 作「手动链接」覆盖（优先级低于 manualAppId，高于自动解析）──
test("H1：parsed.appid 作手动链接覆盖，跳过英文名解析，直接驱动封面/介绍/大小", async () => {
  let resolveCalled = false;
  const deps = baseDeps({
    resolveEnglishName: async () => { resolveCalled = true; return "ShouldNotBeUsed"; },
    // 不覆盖 downloadCover：沿用默认实现（含 downloadCoverCount++），以验证封面下载被驱动
  });
  const parsed = baseParsed({ appid: "2531310" }); // 模拟解析输入时从粘贴的 Steam 链接抽到 AppID
  const res = await autoExecute(parsed, null, "/tmp", { deps });
  const appidStep = res.steps.find(s => s.name === "Steam AppID");
  assert.strictEqual(appidStep.status, "成功");
  assert.strictEqual(appidStep.appid, "2531310");
  assert.strictEqual(appidStep.source, "手动链接", "来源应标注手动链接");
  assert.strictEqual(resolveCalled, false, "已有 appid 应跳过英文名解析（省一次请求）");
  assert.strictEqual(deps._state().downloadCoverCount, 1, "有 appid 应走 Steam 封面");
});

test("H1：manualAppId 优先于 parsed.appid（程序化覆盖胜出）", async () => {
  const deps = baseDeps({ downloadCover: async () => "/fake/steam.jpg" });
  const parsed = baseParsed({ appid: "2531310" });
  const res = await autoExecute(parsed, "999", "/tmp", { deps });
  const appidStep = res.steps.find(s => s.name === "Steam AppID");
  assert.strictEqual(appidStep.appid, "999");
  assert.strictEqual(appidStep.source, "手动录入");
});

test("需求：先查重（list_records）再创建记录，且顺序正确", async () => {
  const deps = baseDeps();
  await autoExecute(baseParsed(), null, "/tmp", { deps });
  const fns = deps._state().calls.filter(c => c.fn === "dbsheet.list_records" || c.fn === "dbsheet.create_records").map(c => c.fn);
  assert.ok(fns.includes("dbsheet.list_records"), "应调用查重");
  assert.ok(fns.includes("dbsheet.create_records"), "应创建记录");
  assert.ok(fns.indexOf("dbsheet.list_records") < fns.indexOf("dbsheet.create_records"), "查重必须在创建之前");
});

test("需求：创建记录后调用 get_record 验证", async () => {
  const deps = baseDeps();
  await autoExecute(baseParsed(), null, "/tmp", { deps });
  const get = deps._state().calls.find(c => c.fn === "dbsheet.get_record");
  assert.ok(get, "应调用 get_record 验证记录");
  assert.strictEqual(get.args.record_id, "r1");
});

test("需求：附件上传参数正确（文件名含游戏名、类型、base64）", async () => {
  const deps = baseDeps({ searchSteamAppId: async () => "12345" });
  await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp", { deps });
  const up = deps._state().calls.find(c => c.fn === "upload_attachment");
  assert.ok(up, "应上传附件");
  assert.ok(up.args.filename.includes("双影奇境"), "文件名应含游戏名");
  assert.strictEqual(up.args.content_type, "image/jpeg");
  assert.ok(up.args.content_base64 && up.args.content_base64.length > 0, "应包含 base64 内容");
});

test("需求：创建记录字段完整（游戏信息/更新日期/作品展示/网盘数组）", async () => {
  const deps = baseDeps({ searchSteamAppId: async () => "12345" });
  const res = await autoExecute(baseParsed({ tags: ["PC游戏", "动作"], baiduUrl: "https://pan.baidu.com/s/b" }), null, "/tmp", { deps });
  const f = deps._state().lastCreate;
  // 游戏信息含分类标签(默认) + 原始标签 + 数据溯源标签（介绍/大小来源）；分类与 parsed 重合时去重
  // 默认无 Steam 官方描述 → 介绍占位、大小待核、需人工校对
  assert.deepStrictEqual(f["游戏信息"], ["免安装硬盘版", "PC游戏", "全DLC", "动作", "介绍:占位", "大小:待核", "⚠需人工校对"], "游戏信息含分类标签 + 原始标签 + 溯源标签");
  assert.ok(/^\d{4}\/\d{2}\/\d{2}$/.test(f["更新日期"]), "更新日期应为 YYYY/MM/DD");
  assert.ok(f["作品展示"] && f["作品展示"][0].uploadId === "obj1" && f["作品展示"][0].source === "upload_ks3", "应带作品展示附件");
  assert.deepStrictEqual(f["百度网盘"], [{ address: "https://pan.baidu.com/s/b", displayText: "https://pan.baidu.com/s/b" }], "百度网盘应为地址数组");
});

// ── 封面缺失语义（P0-1 修复后）──
// 封面是尽力而为：下载「真实报错」记为「警告」(不拉红整体)，并置 coverStatus='failed' 供前端显式提示；
// 下载「无来源」(无 appid 且无手动链接) 记为「跳过」且 coverStatus='absent'，属合理留空。
// 二者均不阻断记录创建，但失败不再被洗白成无声的 success。
test("onStep 实时回调：每步 emit step（带 index），结束 emit done", async () => {
  const events = [];
  const deps = baseDeps();
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp", {
    deps,
    onStep: (ev) => events.push(ev),
  });
  // 至少应有若干 step 事件 + 一个 done 事件
  const stepEvents = events.filter(e => e.type === "step");
  const doneEvents = events.filter(e => e.type === "done");
  assert.ok(stepEvents.length >= 3, "应至少推送 3 个 step 事件");
  assert.strictEqual(doneEvents.length, 1, "应恰好推送 1 个 done 事件");
  // 每个 step 事件都带稳定 index，便于前端原地更新
  const indices = stepEvents.map(e => e.step.index);
  assert.ok(indices.every(i => Number.isInteger(i) && i >= 0), "step 事件应带非负 index");
  // done 事件携带完整结果与 gameName 之外的字段
  assert.strictEqual(doneEvents[0].result.recordId, "r1");
  assert.strictEqual(doneEvents[0].result.success, true);
  // 最终返回结果与回调收到的 done.result 一致
  assert.strictEqual(res.recordId, "r1");
});

test("封面无来源（无 AppID 且无手动链接）→ 跳过 + coverStatus='absent'，仍判 success 且无作品展示", async () => {
  const deps = baseDeps(); // searchSteamAppId null → 无 appid，无 manualCoverUrl → 无来源
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const coverSteps = res.steps.filter(s => s.name.includes("封面"));
  assert.ok(coverSteps.length >= 1 && coverSteps.every(s => s.status === "跳过"), "无来源应记为跳过");
  assert.strictEqual(res.coverStatus, "absent", "无来源应为 absent");
  assert.strictEqual(res.success, true, "合理留空不应失败");
  assert.ok(!("作品展示" in deps._state().lastCreate), "无封面则不应有作品展示");
});

test("P0-1 修复：封面下载真实报错 → 警告 + coverStatus='failed'，仍判 success 但无作品展示", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    downloadCover: async () => { throw new Error("Steam CDN 503"); },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const coverSteps = res.steps.filter(s => s.name.includes("封面"));
  assert.ok(coverSteps.some(s => s.status === "警告"), "真实报错应记为警告");
  assert.strictEqual(res.coverStatus, "failed", "下载报错应为 failed");
  assert.strictEqual(res.success, true, "警告不拉红整体（封面尽力而为）");
  assert.ok(!("作品展示" in deps._state().lastCreate), "无封面则不应有作品展示");
});

test("P0-3 修复：封面下载成功但上传失败 → coverLost + 回传 coverPath 供补传", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    downloadCover: async () => "/fake/steam.jpg",
    callMcporter: (fn) => { if (fn === "upload_attachment") return { data: {} }; return { data: { records: [{ id: "r1" }] } }; },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  assert.strictEqual(res.coverStatus, "failed", "下载成功但上传失败应为 failed");
  assert.strictEqual(res.coverLost, true, "应标记 coverLost");
  assert.strictEqual(res.coverPath, "/fake/steam.jpg", "应回传本地封面路径供补传");
  assert.strictEqual(res.success, false, "上传失败步骤记失败，整体 success 应为 false");
});

// ── 查重分支（1.0.18 新增：文档已存在时提示跳过 / 强制新增 / 更新网盘链接）──
const DUP_REC = { id: "dup1", fields: { "游戏名称": "双影奇境（Split Fiction）", "百度网盘": [{ address: "https://pan.baidu.com/s/old", displayText: "https://pan.baidu.com/s/old" }] } };

test("查重命中且默认（不选强制/更新）→ 跳过（action=skipped，不创建）", async () => {
  const deps = baseDeps({ listRecords: [DUP_REC] });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  assert.strictEqual(res.action, "skipped");
  assert.strictEqual(res.recordId, "dup1");
  assert.strictEqual(res.success, true);
  const creates = deps._state().calls.filter(c => c.fn === "dbsheet.create_records");
  assert.strictEqual(creates.length, 0, "命中应跳过创建");
  const ups = deps._state().calls.filter(c => c.fn === "dbsheet.update_records");
  assert.strictEqual(ups.length, 0, "命中默认不更新");
});

test("查重命中 + forceAdd → 仍创建（action=created）", async () => {
  const deps = baseDeps({ listRecords: [DUP_REC] });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps, forceAdd: true });
  assert.strictEqual(res.action, "created");
  assert.strictEqual(res.recordId, "r1");
  const creates = deps._state().calls.filter(c => c.fn === "dbsheet.create_records");
  assert.strictEqual(creates.length, 1, "强制新增应创建一条");
});

test("查重命中 + updateLinks → 部分更新网盘链接（action=updated，不创建）", async () => {
  const deps = baseDeps({ listRecords: [DUP_REC] });
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/q" }), null, "/tmp", { deps, updateLinks: true });
  assert.strictEqual(res.action, "updated");
  assert.strictEqual(res.recordId, "dup1");
  const ups = deps._state().calls.filter(c => c.fn === "dbsheet.update_records");
  assert.strictEqual(ups.length, 1, "应调用 update_records");
  const upFields = ups[0].args.records[0].fields;
  assert.ok(upFields["夸克网盘"], "应更新夸克网盘");
  assert.ok(!("百度网盘" in upFields), "未填百度则不应更新百度（部分更新）");
  assert.ok(!("游戏介绍" in upFields), "不应动介绍字段（部分更新）");
  assert.ok(!("游戏名称" in upFields), "不应动游戏名称字段（部分更新）");
  const creates = deps._state().calls.filter(c => c.fn === "dbsheet.create_records");
  assert.strictEqual(creates.length, 0, "更新模式不应创建");
});

test("查重命中 + updateLinks 但本次无网盘链接 → 跳过（action=skipped，不更新）", async () => {
  const deps = baseDeps({ listRecords: [DUP_REC] });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps, updateLinks: true });
  assert.strictEqual(res.action, "skipped");
  const ups = deps._state().calls.filter(c => c.fn === "dbsheet.update_records");
  assert.strictEqual(ups.length, 0, "无链接不应调用 update");
});

test("查重未命中 → 正常创建（action=created），list_records 先于 create_records", async () => {
  const deps = baseDeps({ listRecords: [] });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  assert.strictEqual(res.action, "created");
  const fns = deps._state().calls.filter(c => c.fn === "dbsheet.list_records" || c.fn === "dbsheet.create_records").map(c => c.fn);
  assert.ok(fns.includes("dbsheet.list_records"), "应先查重");
  assert.ok(fns.indexOf("dbsheet.list_records") < fns.indexOf("dbsheet.create_records"), "查重先于创建");
});

// ── 游戏大小优先级：Steam 官方 → 文本识别 → 空 ──
test("resolveGameSize 优先级：Steam 官方 > 文本识别 > 空（并归一化）", () => {
  assert.strictEqual(resolveGameSize({ steam: "40GB" }, ""), "40G", "Steam 官方优先且归一化");
  assert.strictEqual(resolveGameSize({ steam: "40GB" }, "99G"), "40G", "Steam 官方严格优先于文本");
  assert.strictEqual(resolveGameSize({}, "25G"), "25G", "无 Steam 时文本识别兜底且归一化");
  assert.strictEqual(resolveGameSize({}, ""), "", "全空返回空串（不写字段）");
});

// ── AppID 多源取拿 + Steam 官方大小兜底（2026-08-04 新增）──
test("AppID 多源取拿：Steam 搜索未命中时回退维基百科，并驱动 Steam 封面", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => null,
    fetchAppIdFromWikidata: async () => "2461850", // Split Fiction 真实 appid
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const appidStep = res.steps.find(s => s.name === "Steam AppID");
  assert.strictEqual(appidStep.status, "成功");
  assert.strictEqual(appidStep.appid, "2461850");
  assert.strictEqual(appidStep.source, "维基百科", "应标注来源维基百科");
  // 拿到 appid 后应走 Steam 官方封面
  assert.strictEqual(deps._state().downloadCoverCount, 1, "有 appid 应走 Steam 官方封面");
});

test("AppID 多源取拿：维基未命中时回退百度百科", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => null,
    fetchAppIdFromWikidata: async () => null,
    fetchAppIdFromBaiduBaike: async () => "1086940",
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const appidStep = res.steps.find(s => s.name === "Steam AppID");
  assert.strictEqual(appidStep.status, "成功");
  assert.strictEqual(appidStep.appid, "1086940");
  assert.strictEqual(appidStep.source, "百度百科");
});

// ── 英文名前置解析（2026-08-04 新增：中文名 → 英文名 → 优先英文名匹配）──
test("英文名前置：解析到英文名后优先用英文名去 Steam 搜索，未命中再回退中文名", async () => {
  const steamCalls = [];
  const deps = baseDeps({
    resolveEnglishName: async () => "Elden Ring",
    searchSteamAppId: async (name) => { steamCalls.push(name); return null; }, // 模拟 Steam 未命中，验证调用顺序
    fetchAppIdFromWikidata: async () => "1245620",
  });
  const res = await autoExecute(baseParsed({ gameName: "艾尔登法环", englishName: "" }), null, "/tmp", { deps });
  assert.strictEqual(steamCalls[0], "Elden Ring", "应优先用解析到的英文名去 Steam 搜索");
  assert.strictEqual(steamCalls[1], "艾尔登法环", "英文名未命中时应回退中文名");
  const appidStep = res.steps.find(s => s.name === "Steam AppID");
  assert.strictEqual(appidStep.appid, "1245620", "最终应经维基拿到 AppID");
  assert.strictEqual(appidStep.source, "维基百科");
});

test("英文名前置：未解析到英文名时直接用中文名匹配，不报错", async () => {
  const steamCalls = [];
  const deps = baseDeps({
    resolveEnglishName: async () => "", // 没查到
    searchSteamAppId: async (name) => { steamCalls.push(name); return null; },
    fetchAppIdFromWikidata: async () => "999",
  });
  const res = await autoExecute(baseParsed({ gameName: "某冷门游戏", englishName: "" }), null, "/tmp", { deps });
  assert.strictEqual(steamCalls[0], "某冷门游戏", "无英文名时应直接用中文名搜 Steam");
  assert.strictEqual(res.steps.find(s => s.name === "Steam AppID").appid, "999");
});

test("英文名前置：手动录入的英文名优先于自动解析（不再发额外解析请求）", async () => {
  const steamCalls = [];
  let resolveCalled = false;
  const deps = baseDeps({
    resolveEnglishName: async () => { resolveCalled = true; return "AutoName"; },
    searchSteamAppId: async (name) => { steamCalls.push(name); return null; },
    fetchAppIdFromWikidata: async () => "123",
  });
  // parsed.englishName 模拟用户手动录入
  const res = await autoExecute(baseParsed({ gameName: "游戏", englishName: "ManualName" }), null, "/tmp", { deps });
  assert.strictEqual(resolveCalled, false, "手动录入英文名时应跳过自动解析");
  assert.strictEqual(steamCalls[0], "ManualName", "应直接用手动录入的英文名去 Steam 搜");
});

test("游戏大小兜底：Steam 官方大小在无网盘真实大小时生效", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ shortDescription: "x".repeat(20), size: "40GB" }),
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏大小"], "40G", "Steam 大小经归一化 40GB→40G");
  assert.strictEqual(res.sizeProvenance, "Steam官方", "溯源标签应为 Steam官方");
});

test("游戏大小兜底：仅 Steam 官方一个真实来源（无网盘大小）", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ shortDescription: "x".repeat(20), size: "40GB" }),
  });
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏大小"], "40G", "Steam 大小经归一化 40GB→40G");
  assert.strictEqual(res.sizeProvenance, "Steam官方", "溯源标签应为 Steam官方（quarkUrl 不再触发任何大小步骤）");
});

// ── 游戏介绍兜底（v0.1.48 → 2026-08-04 移除 bl：Steam 官方主源 + 占位待核对）──
test("介绍主源：Steam 官方描述优先（provenance=Steam官方）", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ shortDescription: "Steam 官方：一款双人合作动作冒险游戏。", size: "30.7GB", genres: ["动作"], type: "game" }),
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏介绍"], "Steam 官方：一款双人合作动作冒险游戏。", "应使用 Steam 官方描述");
  assert.strictEqual(res.introProvenance, "Steam官方");
  assert.strictEqual(res.sizeProvenance, "Steam官方", "大小也来自 Steam 官方");
  assert.strictEqual(res.needsReview, false, "介绍与大小均有官方来源则无需校对");
  assert.ok(lastCreate["游戏信息"].includes("介绍:Steam官方"), "溯源标签应写入游戏信息");
});

test("介绍降级：Steam 有 AppID 但无官方描述时占位（provenance=占位）+ needsReview", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => null, // 有 appid 但无官方描述
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏介绍"], "介绍待补充", "无官方描述应占位");
  assert.strictEqual(res.introProvenance, "占位");
  assert.strictEqual(res.needsReview, true, "占位应标记需人工校对");
  assert.ok(lastCreate["游戏信息"].includes("介绍:占位"));
});

test("介绍兜底：双无（无 AppID 且无官方描述）则占位 + needsReview（不再用标题/免责声明洗白）", async () => {
  const deps = baseDeps({
    searchSteamAppId: async () => null,
    getSteamAppDetails: async () => null,
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏介绍"], "介绍待补充", "双无应占位而非标题/免责声明");
  assert.strictEqual(res.introProvenance, "占位");
  assert.strictEqual(res.needsReview, true, "占位应标记需人工校对");
  assert.ok(lastCreate["游戏信息"].includes("⚠需人工校对"), "需校对标签应写入游戏信息");
  assert.ok(lastCreate["游戏信息"].includes("介绍:占位"));
});

test("大小全缺失 → 不写游戏大小 + needsReview=true + 溯源=待核", async () => {
  const deps = baseDeps(); // 无 Steam 大小 + parsed.size 默认空
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.ok(!("游戏大小" in lastCreate), "大小全缺失不写字段");
  assert.strictEqual(res.sizeProvenance, "待核");
  assert.strictEqual(res.needsReview, true, "大小缺失应标记需校对");
});

// ── buildRecordFields 写入溯源/校对标签 ──
test("buildRecordFields 写入 provenance 与 needsReview 标签", () => {
  const fields = buildRecordFields(baseParsed(), {
    desc: "介绍文本", coverPath: null, objectId: null, gameSize: "30.7GB",
    coverSize: 0, needsReview: true, introProvenance: "占位", sizeProvenance: "待核",
  });
  // 分类标签默认会写最前（用户偏好"免安装/PC/全DLC"）；PC游戏与 parsed.tags 重合时去重
  assert.deepStrictEqual(
    fields["游戏信息"],
    ["免安装硬盘版", "PC游戏", "全DLC", "介绍:占位", "大小:待核", "⚠需人工校对"]
  );
});

test("buildRecordFields 未传溯源参数时仅保留分类标签+原始标签（不污染）", () => {
  const fields = buildRecordFields(baseParsed({ tags: ["PC游戏", "动作"] }), {
    desc: "x", coverPath: "/x/c.jpg", objectId: null, gameSize: "", coverSize: 0,
  });
  // 分类标签在前；PC游戏与 parsed.tags 重合 → 去重保留前者
  assert.deepStrictEqual(fields["游戏信息"], ["免安装硬盘版", "PC游戏", "全DLC", "动作"]);
  assert.strictEqual(fields["游戏大小"], undefined);
});

test("buildRecordFields 显式传空 classificationTags 时只用 parsed.tags", () => {
  const fields = buildRecordFields(baseParsed({ tags: ["PC游戏", "动作"] }), {
    desc: "x", coverPath: null, objectId: null, gameSize: "", coverSize: 0,
    classificationTags: [],
  });
  assert.deepStrictEqual(fields["游戏信息"], ["PC游戏", "动作"]);
});

test("buildRecordFields 自定义 classificationTags 覆盖默认", () => {
  const fields = buildRecordFields(baseParsed(), {
    desc: "x", coverPath: null, objectId: null, gameSize: "", coverSize: 0,
    classificationTags: ["免安装硬盘版", "虚拟机版"], // 用户临时改主意：去掉 PC游戏、全DLC，加 虚拟机版
  });
  assert.deepStrictEqual(fields["游戏信息"], ["免安装硬盘版", "虚拟机版", "PC游戏"]);
});

test("buildRecordFields classificationTags 与 parsed.tags 去重保序（PC游戏/全DLC 重复）", () => {
  // parser 已从 "游戏名（X）全DLC" 检测到 ["全DLC", "PC游戏"]；分类标签再次写 PC游戏/全DLC 应去重
  const fields = buildRecordFields(
    baseParsed({ tags: ["全DLC", "PC游戏"] }),
    { desc: "x", coverPath: null, objectId: null, gameSize: "", coverSize: 0 }
  );
  assert.deepStrictEqual(fields["游戏信息"], ["免安装硬盘版", "PC游戏", "全DLC"]);
});

test("buildRecordFields 组装字段（网盘链接 + 封面对象）", () => {
  const parsed = baseParsed({ baiduUrl: "https://pan.baidu.com/s/b", quarkUrl: "https://pan.quark.cn/s/q" });
  const fields = buildRecordFields(parsed, { desc: "介绍文本", coverPath: "/x/cover.jpg", objectId: "obj9", gameSize: "30.7G", coverSize: 1234 });
  assert.strictEqual(fields["游戏名称"], parsed.gameName);
  assert.strictEqual(fields["游戏介绍"], "介绍文本");
  assert.strictEqual(fields["游戏大小"], "30.7G");
  assert.deepStrictEqual(fields["百度网盘"], [{ address: parsed.baiduUrl, displayText: parsed.baiduUrl }]);
  assert.deepStrictEqual(fields["夸克网盘"], [{ address: parsed.quarkUrl, displayText: parsed.quarkUrl }]);
  assert.strictEqual(fields["作品展示"][0].uploadId, "obj9");
  assert.strictEqual(fields["作品展示"][0].size, 1234);
  assert.strictEqual(fields["作品展示"][0].type, "image/jpeg");
});

test("buildRecordFields 无 objectId 时不带封面对象，无大小不写大小字段", () => {
  const fields = buildRecordFields(baseParsed(), { desc: "x", coverPath: "/x/c.jpg", objectId: null, gameSize: "", coverSize: 0 });
  assert.strictEqual(fields["作品展示"], undefined, "无 objectId 不应带封面对象");
  assert.strictEqual(fields["游戏大小"], undefined, "无大小不写字段");
});

test("findExistingRecord 持续返回 offset 时不超过 MAX_PAGES 页（防死循环）", async () => {
  let calls = 0;
  const deps = { callMcporter: async () => { calls++; return { data: { detail: { records: [], offset: "off-" + calls } } }; } };
  const res = await findExistingRecord(baseParsed(), deps);
  assert.strictEqual(res.exists, false);
  assert.ok(calls <= 50, `翻页次数 ${calls} 应 ≤ 50，实际 ${calls}`);
});

test("查重命中 + updateLinks 但更新失败 → success:false 且 action:update_failed", async () => {
  const deps = baseDeps({
    listRecords: [DUP_REC],
    callMcporter: (fn) => {
      if (fn === "dbsheet.update_records") throw new Error("网络错误");
      if (fn === "dbsheet.list_records") return { data: { detail: { records: [DUP_REC] } } };
      if (fn === "upload_attachment") return { object_id: "obj1" };
      return { data: { records: [{ id: "r1" }] } };
    },
  });
  const res = await autoExecute(baseParsed({ baiduUrl: "https://pan.baidu.com/s/new" }), null, "/tmp", { deps, updateLinks: true });
  assert.strictEqual(res.success, false, "更新失败应 success:false");
  assert.strictEqual(res.action, "update_failed", "更新失败 action 语义应为 update_failed（而非 updated 误导）");
});
