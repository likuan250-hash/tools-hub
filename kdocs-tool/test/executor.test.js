// executor.test.js — 编排流程单元测试（注入 fake deps，不依赖外部 CLI）
const test = require("node:test");
const assert = require("node:assert");
const { autoExecute } = require("../lib/executor");

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
    aiDescribe: () => ({ intro: "Hazelight 开发的双人合作冒险游戏。", size: "30.7G", coverUrl: "https://cdn.x.com/a.jpg" }),
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

test("正常流程字段映射正确", async () => {
  const deps = baseDeps();
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp/cover", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(res.recordId, "r1");
  assert.strictEqual(lastCreate["游戏名称"], "双影奇境（Split Fiction）");
  assert.strictEqual(lastCreate["游戏介绍"], "Hazelight 开发的双人合作冒险游戏。");
  assert.strictEqual(lastCreate["游戏大小"], "30.7G");
  assert.strictEqual(lastCreate["夸克网盘"][0].address, "https://pan.quark.cn/s/x");
});

test("游戏大小优先级：ai.size > parsed.size > quarkSize", async () => {
  // ai 优先
  let deps = baseDeps({ aiDescribe: () => ({ intro: "x".repeat(20), size: "10G", coverUrl: "" }) });
  await autoExecute(baseParsed({ size: "5G" }), null, "/tmp", { deps });
  assert.strictEqual(deps._state().lastCreate["游戏大小"], "10G");

  // ai 空 → parsed 优先
  deps = baseDeps({ aiDescribe: () => ({ intro: "x".repeat(20), size: "", coverUrl: "" }) });
  await autoExecute(baseParsed({ size: "5G" }), null, "/tmp", { deps });
  assert.strictEqual(deps._state().lastCreate["游戏大小"], "5G");
});

test("含免责声明的介绍被丢弃，用原始名兜底", async () => {
  const deps = baseDeps({ aiDescribe: () => ({ intro: "该游戏经核实无真实公开资料，疑似虚构，请勿轻信。", size: "", coverUrl: "" }) });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const { lastCreate } = deps._state();
  assert.strictEqual(lastCreate["游戏介绍"], "双影奇境（Split Fiction）");
});

test("大小缺失时不再提示手动填写，直接不写入游戏大小字段", async () => {
  const deps = baseDeps({ aiDescribe: () => ({ intro: "x".repeat(20), size: "", coverUrl: "" }) });
  const res = await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp", { deps });
  const sizeStep = res.steps.find(s => s.name === "游戏大小抓取");
  assert.strictEqual(sizeStep, undefined, "不应再出现游戏大小抓取提示步骤");
  assert.ok(!("游戏大小" in deps._state().lastCreate));
  assert.strictEqual(res.success, true, "大小缺失不应导致失败");
});

test("封面优先级：bl 推荐优先，Steam 兜底不被调用", async () => {
  const deps = baseDeps({ searchSteamAppId: async () => "12345" });
  await autoExecute(baseParsed(), "12345", "/tmp", { deps });
  const { downloadCoverCount, downloadFromUrlCount } = deps._state();
  assert.strictEqual(downloadFromUrlCount, 1, "bl 推荐封面应被下载");
  assert.strictEqual(downloadCoverCount, 0, "已有 bl 封面时不应再走 Steam 兜底");
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
  const deps = baseDeps();
  await autoExecute(baseParsed({ quarkUrl: "https://pan.quark.cn/s/x" }), null, "/tmp", { deps });
  const up = deps._state().calls.find(c => c.fn === "upload_attachment");
  assert.ok(up, "应上传附件");
  assert.ok(up.args.filename.includes("双影奇境"), "文件名应含游戏名");
  assert.strictEqual(up.args.content_type, "image/jpeg");
  assert.ok(up.args.content_base64 && up.args.content_base64.length > 0, "应包含 base64 内容");
});

test("需求：创建记录字段完整（游戏信息/更新日期/作品展示/网盘数组）", async () => {
  const deps = baseDeps();
  const res = await autoExecute(baseParsed({ tags: ["PC游戏", "动作"], baiduUrl: "https://pan.baidu.com/s/b" }), null, "/tmp", { deps });
  const f = deps._state().lastCreate;
  assert.deepStrictEqual(f["游戏信息"], ["PC游戏", "动作"], "游戏信息应为标签数组");
  assert.ok(/^\d{4}\/\d{2}\/\d{2}$/.test(f["更新日期"]), "更新日期应为 YYYY/MM/DD");
  assert.ok(f["作品展示"] && f["作品展示"][0].uploadId === "obj1" && f["作品展示"][0].source === "upload_ks3", "应带作品展示附件");
  assert.deepStrictEqual(f["百度网盘"], [{ address: "https://pan.baidu.com/s/b", displayText: "https://pan.baidu.com/s/b" }], "百度网盘应为地址数组");
});

// ── 需求冲突点（已知行为，待用户确认是否改为失败）──
// 用户需求：bl / 兜底必须给封面。但当前 success 判定为「全成功或跳过」，
// 封面所有源失败仅记为「跳过」，仍会创建无作品展示的记录。
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

test("需求GAP：封面所有源失败 → 当前仍判 success 且不含作品展示（待确认）", async () => {
  const deps = baseDeps({ aiDescribe: () => ({ intro: "x".repeat(20), size: "10G", coverUrl: "" }) });
  const res = await autoExecute(baseParsed(), null, "/tmp", { deps });
  const coverSteps = res.steps.filter(s => s.name.includes("封面"));
  assert.ok(coverSteps.length >= 1 && coverSteps.every(s => s.status === "跳过"), "封面应全部跳过");
  assert.strictEqual(res.success, true, "（已知行为）封面缺失仍判成功，与「必须有封面」需求冲突");
  assert.ok(!("作品展示" in deps._state().lastCreate), "无封面则不应有作品展示");
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
