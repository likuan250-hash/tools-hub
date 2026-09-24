// executor.cloud.test.js — 云库线路（第二条录入线路）单测
// 重点验证：默认不跑云库（兼容旧调用）、双线路互不拖累、云库失败不拉红金山。
const test = require("node:test");
const assert = require("node:assert");
const { autoExecute, resolveTargets } = require("../lib/executor");

function baseParsed(over = {}) {
  return {
    gameName: "双影奇境", englishName: "Split Fiction",
    baiduUrl: "", quarkUrl: "", xunleiUrl: "",
    tags: ["PC游戏"], raw: "双影奇境（Split Fiction）",
    size: "", coverUrl: "",
    ...over,
  };
}

/** 构造假云库客户端：默认「有密码 + 未命中 + 入库成功」。 */
function fakeCloud(over = {}) {
  const calls = { setCover: [], insert: [], findDup: [], buildRow: [] };
  const cloud = {
    hasCredentials: () => true,
    getToken: async () => "tok",
    findDup: async (name) => { calls.findDup.push(name); return null; },
    buildRow: (parsed, extra) => { calls.buildRow.push({ parsed, extra }); return { name: parsed.raw, doc_date: "2026-09-24" }; },
    insert: async (row) => { calls.insert.push(row); return { id: 292, action: "insert" }; },
    setCover: async (id, p) => { calls.setCover.push({ id, path: p }); return { thumb: "ok", full: "ok" }; },
    calls,
    ...over,
  };
  return cloud;
}

function baseDeps(over = {}) {
  let lastCreate = null;
  const deps = {
    checkKdocsReady: () => true,
    searchSteamAppId: async () => null,
    getSteamAppDetails: async () => null,
    fetchAppIdFromWikidata: async () => null,
    fetchAppIdFromBaiduBaike: async () => null,
    fetchAppIdFromWebSearch: async () => null,
    fetchWikiIntro: async () => null,
    resolveEnglishName: async () => "",
    downloadCover: async () => "/fake/steam.jpg",
    downloadCoverFromUrl: async () => "/fake/cover.jpg",
    fileBase64: () => "base64data",
    callMcporter: (fn, args) => {
      if (fn === "dbsheet.create_records") lastCreate = args.records[0].fields;
      if (fn === "upload_attachment") return { object_id: "obj1" };
      if (fn === "dbsheet.list_records") return { data: { detail: { records: [] } } };
      return { data: { records: [{ id: "r1" }] } };
    },
    fs: { statSync: () => ({ size: 1234 }) },
    _state: () => ({ lastCreate }),
    ...over,
  };
  return deps;
}

test("resolveTargets：缺省（不传 targets）只走金山 —— 兼容历史调用与全部既有单测", () => {
  assert.deepStrictEqual(resolveTargets(undefined), { kdocs: true, cloud: true });
  assert.deepStrictEqual(resolveTargets(null), { kdocs: true, cloud: true });
  assert.deepStrictEqual(resolveTargets({ kdocs: true, cloud: true }), { kdocs: true, cloud: true });
  assert.deepStrictEqual(resolveTargets({ kdocs: false, cloud: true }), { kdocs: false, cloud: true });
});

test("不传 targets 时默认也跑云库（缺省 = 金山 + 云库都开）", async () => {
  const cloud = fakeCloud();
  const events = [];
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud }),
    onStep: (ev) => events.push(ev),
  });
  assert.ok(res.cloud, "缺省应产生云库结果");
  assert.ok(events.filter((e) => e.group === "cloud").length > 0, "应有云库步骤事件");
  assert.strictEqual(cloud.calls.insert.length, 1, "缺省应执行一次云库入库");
});

test("双线路：金山成功 + 云库入库成功，两条都留痕且互不覆盖 index", async () => {
  const cloud = fakeCloud();
  const events = [];
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud }),
    targets: { kdocs: true, cloud: true },
    onStep: (ev) => events.push(ev),
  });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.cloud.ok, true);
  assert.strictEqual(res.cloud.action, "created");
  assert.strictEqual(res.cloud.id, 292);
  const kdocsIdx = events.filter((e) => e.group === "kdocs").map((e) => e.step.index);
  const cloudIdx = events.filter((e) => e.group === "cloud").map((e) => e.step.index);
  assert.ok(kdocsIdx.length > 0 && cloudIdx.length > 0, "两条线路都应有步骤事件");
  assert.strictEqual(Math.min(...cloudIdx), 0, "云库步骤 index 从 0 起（独立编号）");
});

test("云库未配置密码 → 线路跳过，金山结果不受影响", async () => {
  const cloud = fakeCloud({ hasCredentials: () => false });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud }),
    targets: { kdocs: true, cloud: true },
  });
  assert.strictEqual(res.success, true, "金山仍应成功");
  assert.strictEqual(res.cloud.ok, false);
  assert.strictEqual(res.cloud.action, "no_password");
  assert.strictEqual(res.cloud.skipped, true);
  assert.strictEqual(cloud.calls.insert.length, 0, "没密码不应尝试入库");
});

test("云库入库失败 → 只标红云库线路，金山整体仍判成功", async () => {
  const cloud = fakeCloud({ insert: async () => { throw new Error("boom"); } });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud }),
    targets: { kdocs: true, cloud: true },
  });
  assert.strictEqual(res.success, true, "云库失败不应拉红金山");
  assert.strictEqual(res.cloud.ok, false);
  assert.strictEqual(res.cloud.action, "insert_failed");
  assert.match(res.cloud.error, /boom/);
});

test("云库查重命中同名 → 跳过（云库没有更新接口，只能跳过）", async () => {
  const cloud = fakeCloud({ findDup: async () => ({ id: 88, name: "双影奇境（Split Fiction）" }) });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud }),
    targets: { kdocs: true, cloud: true },
  });
  assert.strictEqual(res.cloud.ok, true);
  assert.strictEqual(res.cloud.action, "skipped");
  assert.strictEqual(res.cloud.id, 88);
  assert.strictEqual(cloud.calls.insert.length, 0, "命重不应再插入");
});

test("只勾云库 → 完全不跑金山（不调用 kdocs CLI），以云库成败判整体", async () => {
  const cloud = fakeCloud();
  const mcporterCalls = [];
  const deps = baseDeps({
    cloud,
    callMcporter: (fn) => { mcporterCalls.push(fn); return { data: { records: [] } }; },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps,
    targets: { kdocs: false, cloud: true },
  });
  assert.strictEqual(mcporterCalls.length, 0, "只勾云库时不应调用任何金山 CLI");
  assert.strictEqual(res.action, "cloud_only");
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.cloud.ok, true);
});

test("封面复用：金山线路已下载的封面直接交给云库，不重复下载", async () => {
  const cloud = fakeCloud();
  let coverDownloads = 0;
  const deps = baseDeps({
    cloud,
    searchSteamAppId: async () => "12345",
    downloadCover: async () => { coverDownloads++; return "/fake/steam.jpg"; },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps,
    targets: { kdocs: true, cloud: true },
  });
  assert.strictEqual(coverDownloads, 1, "封面只应下载一次");
  assert.strictEqual(cloud.calls.setCover.length, 1);
  assert.strictEqual(cloud.calls.setCover[0].path, "/fake/steam.jpg");
  assert.strictEqual(res.cloud.ok, true);
});

test("云库字段映射：大小/标签/介绍随金山线路的结果一起带上", async () => {
  const cloud = fakeCloud();
  const res = await autoExecute(baseParsed({ size: "5G" }), null, "/tmp", {
    deps: baseDeps({ cloud }),
    targets: { kdocs: true, cloud: true },
    classificationTags: ["PC游戏", "热门推荐"],
  });
  const extra = cloud.calls.buildRow[0].extra;
  assert.strictEqual(extra.gameSize, "5.0G", "与金山写入的大小保持同一份归一化结果（normalizeSize）");
  assert.deepStrictEqual(extra.tags, ["PC游戏", "热门推荐"]);
  assert.strictEqual(res.cloud.ok, true);
});

test("只勾云库时：标签/大小按与金山一致的规则兜底（shared 里没值也能写全）", async () => {
  const cloud = fakeCloud();
  await autoExecute(baseParsed({ size: "12.3GB" }), null, "/tmp", {
    deps: baseDeps({ cloud }),
    targets: { kdocs: false, cloud: true },
  });
  const extra = cloud.calls.buildRow[0].extra;
  assert.deepStrictEqual(extra.tags, ["免安装硬盘版", "PC游戏", "全DLC"], "未指定时用与金山相同的默认标签");
  assert.strictEqual(extra.gameSize, "12.3G", "大小从粘贴文本识别并归一化");
});

test("金山命重跳过时，云库线路照常执行（两条线路互不牵连）", async () => {
  const cloud = fakeCloud();
  const deps = baseDeps({
    cloud,
    callMcporter: (fn, args) => {
      if (fn === "dbsheet.list_records") {
        return { data: { detail: { records: [{ id: "r9", fields: { 游戏名称: "双影奇境（Split Fiction）" } }] } } };
      }
      return { data: { records: [] } };
    },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps,
    targets: { kdocs: true, cloud: true },
  });
  assert.strictEqual(res.action, "skipped", "金山侧命中重复 → 跳过");
  assert.strictEqual(res.cloud.ok, true, "云库侧仍应独立执行成功");
  assert.strictEqual(cloud.calls.insert.length, 1);
});

// ── 封面来源：金山没给出结论时云库自己搜 Steam（口径与金山一致） ──

test("只勾云库：自己搜 Steam 取封面，并用 appdetails 官方图直链（不靠 CDN 规律路径）", async () => {
  const cloud = fakeCloud();
  let dcArgs = null;
  const deps = baseDeps({
    cloud,
    searchSteamAppId: async () => "12345",
    getSteamAppDetails: async () => ({ headerImage: "https://cdn.akamai/x.jpg" }),
    downloadCover: async (...a) => { dcArgs = a; return "/fake/steam.jpg"; },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps, targets: { kdocs: false, cloud: true },
  });
  assert.strictEqual(cloud.calls.setCover.length, 1, "应把自取的封面传给云库");
  assert.strictEqual(cloud.calls.setCover[0].path, "/fake/steam.jpg");
  assert.strictEqual(dcArgs[3].imageUrl, "https://cdn.akamai/x.jpg", "应带上 appdetails 的官方图直链");
  assert.ok(res.cloud.steps.some((s) => s.name === "云库取封面（Steam）" && s.status === "成功"));
  assert.ok(res.cloud.steps.some((s) => s.name === "云库传封面" && s.status === "成功"));
  assert.strictEqual(res.cloud.ok, true);
});

test("只勾云库：Steam 没匹配到 → 封面警告但不报重复步骤，记录照常入库", async () => {
  const cloud = fakeCloud();
  const deps = baseDeps({ cloud, searchSteamAppId: async () => null });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps, targets: { kdocs: false, cloud: true },
  });
  const names = res.cloud.steps.map((s) => s.name);
  assert.ok(names.includes("云库取封面（Steam）"), "应留下取封面的步骤");
  assert.ok(!names.includes("云库传封面"), "已自行给出结论，不应再补一条重复的「云库传封面」");
  assert.strictEqual(cloud.calls.setCover.length, 0);
  assert.strictEqual(cloud.calls.insert.length, 1, "没封面不影响入库");
  assert.strictEqual(res.cloud.ok, true, "没封面只是警告，不算线路失败");
});

test("金山已跑但没找到封面（shared.coverPath 为空串）→ 云库不重复联网搜 Steam", async () => {
  // 基线：只走金山时搜了几次 Steam，双线路就不该比它多 —— 直接比对，避免硬编码次数
  let kdocsOnlySearches = 0;
  await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud: fakeCloud(), searchSteamAppId: async () => { kdocsOnlySearches++; return null; } }),
    targets: { kdocs: true, cloud: false },
  });
  const cloud = fakeCloud();
  let bothSearches = 0;
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps: baseDeps({ cloud, searchSteamAppId: async () => { bothSearches++; return null; } }),
    targets: { kdocs: true, cloud: true },
  });
  assert.ok(kdocsOnlySearches > 0, "基线应有搜索动作，否则这条测试没意义");
  assert.strictEqual(bothSearches, kdocsOnlySearches, "云库不该在金山已给出封面结论后再搜一遍 Steam");
  assert.ok(!res.cloud.steps.some((s) => s.name === "云库取封面（Steam）"));
  assert.ok(res.cloud.steps.some((s) => s.name === "云库传封面" && s.status === "跳过"));
  assert.strictEqual(res.cloud.ok, true);
});

test("金山命重提前跳过（金山没产出封面结论）→ 云库自己补一张封面", async () => {
  const cloud = fakeCloud();
  const deps = baseDeps({
    cloud,
    searchSteamAppId: async () => "12345",
    downloadCover: async () => "/fake/steam.jpg",
    callMcporter: (fn) => {
      if (fn === "dbsheet.list_records") {
        return { data: { detail: { records: [{ id: "r9", fields: { 游戏名称: "双影奇境（Split Fiction）" } }] } } };
      }
      return { data: { records: [] } };
    },
  });
  const res = await autoExecute(baseParsed(), null, "/tmp", {
    deps, targets: { kdocs: true, cloud: true },
  });
  assert.strictEqual(res.action, "skipped", "金山侧跳过");
  assert.strictEqual(cloud.calls.setCover.length, 1, "云库侧仍应自己把封面补上");
  assert.strictEqual(cloud.calls.setCover[0].path, "/fake/steam.jpg");
});
