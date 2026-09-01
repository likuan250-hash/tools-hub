// routes-api.js 路由测试（express + 临时端口，mock ctx 覆盖纯逻辑分支）
// 覆盖：/api/version、/api/accounts 目录生效路径(id==='0'→'/')、/api/dirs fallback、
//       /api/dirs/:provider/browse 委托、未知 provider 400、/api/transfer 错误码映射(401/400)、
//       DELETE /api/tasks/failed 清空失败记录、/api/health 200/503。
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nd-routes-test-"));
process.env.NETDISK_DATA_DIR = TMP;
process.env.NETDISK_KEY_FILE = path.join(TMP, ".masterkey");

const store = require("../src/store");
const registerApiRoutes = require("../src/routes-api");
const progress = require("../src/progress");

// ── 可变桩：doTransfer 行为可在测试间切换 ──────────────────
let doTransferImpl = async () => ({
  ok: true,
  file_list: [{ server_filename: "a.iso" }],
  task_id: "T1",
});
let quarkSearchImpl = async (cookie, fid, q) => [
  { id: "q1", name: "Q_" + q, isdir: false, size: 1 },
];

let app, server, base;

before(async () => {
  app = express();
  app.use(express.json());
  const ctx = {
    store,
    logger: { info() {}, warn() {}, error() {} },
    baidu: {
      getConfig: () => ({ appDir: "/apps/netdisk_hub" }),
      getLastCheckError: () => "",
      getCookie: () => "ck",
      listSubfolders: async () => [{ id: "/x", name: "x" }],
      searchFiles: async (dir, q) => [{ id: "b1", name: "B_" + q, isdir: false, size: 1 }],
      trashFiles: async (ids) => ({ ok: true, count: ids.length }),
    },
    quark: {
      FOLDER_NAME: "netdisk_hub",
      getValidCookie: () => "ck",
      listSubfolders: async () => [{ id: "f1", name: "f" }],
      searchFiles: (cookie, fid, q) => quarkSearchImpl(cookie, fid, q),
      trashFiles: async (cookie, ids) => ({ ok: true, count: ids.length }),
    },
    xunlei: {
      isConnected: () => true,
      listSubfolders: async () => [{ id: "g1", name: "游戏" }],
      searchFiles: async (parentId, q) => [{ id: "x1", name: "X_" + q, isdir: false, size: 1 }],
      trashFiles: async (ids) => ({ ok: true, count: ids.length }),
    },
    doTransfer: (body) => doTransferImpl(body),
    mapLimit: async (items, n, fn) => Promise.all(items.map((it, i) => fn(it, i))),
    extractSurl: (s) => s,
    isValidShareLink: () => true,
    refreshPings: () => {},
    pingCache: { baidu: true, quark: true, xunlei: true },
    getServerState: () => ({ healthy: true, fatalCount: 0 }),
    getVersion: () => "1.3.30",
    PORT: 3000,
    process,
    path,
    fs,
    __dirname: __dirname,
  };
  registerApiRoutes(app, ctx);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  if (server) server.close();
});

async function get(p) {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function send(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("/api/version：返回版本、来源、不可自更新", async () => {
  const { status, body } = await get("/api/version");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.version, "1.3.30");
  assert.strictEqual(body.source, "standalone");
  assert.strictEqual(body.updatable, false);
});

test('/api/accounts：quark 目录 id==="0" 时生效路径为 "/"', async () => {
  store.setDir("quark", { id: "0", name: "netdisk_hub" });
  const { status, body } = await get("/api/accounts");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.quark.dir.effective, "/", "id=0 应映射为根目录 /");
  assert.strictEqual(body.quark.dir.userSet, true);
});

test("/api/accounts：quark 普通目录生效路径为 /name", async () => {
  store.setDir("quark", { id: "f1", name: "我的目录" });
  const { body } = await get("/api/accounts");
  assert.strictEqual(body.quark.dir.effective, "/我的目录");
});

test('/api/accounts：xunlei 目录无 id 时生效路径为 "/"', async () => {
  store.setDir("xunlei", { id: "", name: "游戏" });
  const { body } = await get("/api/accounts");
  assert.strictEqual(body.xunlei.dir.effective, "/", "无 id 应映射为根目录 /");
});

test("/api/accounts：无 expiresAt（会话级 Cookie）→ loginAt+90 天兜底估算并标记 estimated", async () => {
  const loginAt = new Date("2026-07-29T13:08:30.912Z").toISOString();
  store.saveAccount("baidu", { connected: true, cookie: "BDUSS=x", loginAt });
  const { body } = await get("/api/accounts");
  const expectTs = new Date(loginAt).getTime() + 90 * 24 * 3600 * 1000;
  assert.strictEqual(body.baidu.expiresAt, expectTs, "应返回 loginAt+90 天估算");
  assert.strictEqual(body.baidu.expiresAtEstimated, true, "估算值应标记 estimated");
});

test("/api/accounts：有真实 expiresAt → 原样返回且 estimated=false", async () => {
  const loginAt = new Date("2026-07-29T13:08:30.912Z").toISOString();
  store.saveAccount("quark", {
    connected: true,
    cookie: "__pus=x",
    loginAt,
    expiresAt: 1793106609374,
  });
  const { body } = await get("/api/accounts");
  assert.strictEqual(body.quark.expiresAt, 1793106609374, "真实过期时间应原样返回");
  assert.strictEqual(body.quark.expiresAtEstimated, false);
});

test("/api/dirs/quark：返回选中目录与 fallback", async () => {
  store.setDir("quark", { id: "f1", name: "f" });
  const { status, body } = await get("/api/dirs/quark");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.selected.id, "f1");
  assert.strictEqual(body.fallback, "netdisk_hub");
  assert.strictEqual(body.fallbackName, "netdisk_hub");
});

test("/api/dirs/unknown：未知网盘返回 400", async () => {
  const { status } = await get("/api/dirs/unknown");
  assert.strictEqual(status, 400);
});

test("/api/dirs/quark/browse：委托返回子文件夹", async () => {
  const { status, body } = await get("/api/dirs/quark/browse");
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.folders, [{ id: "f1", name: "f" }]);
});

test("POST /api/dirs/quark：保存目录需 id 与 name", async () => {
  const ok = await send("POST", "/api/dirs/quark", { id: "new", name: "新目录" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.dir.id, "new");
  const missing = await send("POST", "/api/dirs/quark", { id: "x" });
  assert.strictEqual(missing.status, 400);
});

test("POST /api/transfer：成功透传 ok", async () => {
  doTransferImpl = async () => ({ ok: true, file_list: [{ server_filename: "a" }], task_id: "T1" });
  const { status, body } = await send("POST", "/api/transfer", { provider: "quark", link: "x" });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test("POST /api/transfer：未授权错误映射到 401", async () => {
  doTransferImpl = async () => ({ ok: false, error: "网盘未授权，请先授权" });
  const { status } = await send("POST", "/api/transfer", { provider: "quark" });
  assert.strictEqual(status, 401);
});

test("POST /api/transfer：其他错误映射到 400", async () => {
  doTransferImpl = async () => ({ ok: false, error: "分享链接无效" });
  const { status } = await send("POST", "/api/transfer", { provider: "quark" });
  assert.strictEqual(status, 400);
});

test("POST /api/transfer/batch：批量成功返回各结果", async () => {
  doTransferImpl = async (job) => ({ ok: true, file_list: [], task_id: "T-" + job.provider });
  const { status, body } = await send("POST", "/api/transfer/batch", {
    jobs: [{ provider: "quark" }, { provider: "baidu" }],
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.results.length, 2);
  assert.ok(body.results.every((r) => r.ok));
});

test("DELETE /api/tasks/failed：清空失败记录", async () => {
  store.addTask({ status: "failed", provider: "quark", error: "e1" });
  store.addTask({ status: "failed", provider: "baidu", error: "e2" });
  store.addTask({ status: "success", provider: "xunlei" });
  const before = store.getTasks().filter((t) => t.status === "failed").length;
  assert.strictEqual(before, 2, "准备 2 条失败记录");
  const { status, body } = await send("DELETE", "/api/tasks/failed");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.removed, 2);
  const after = store.getTasks().filter((t) => t.status === "failed").length;
  assert.strictEqual(after, 0, "失败记录应被清空");
  const successKept = store.getTasks().filter((t) => t.status === "success").length;
  assert.strictEqual(successKept, 1, "成功记录应保留");
});

test("/api/health：已配置且健康返回 200", async () => {
  store.saveAccount("quark", { cookie: "ck", connected: true });
  const { status, body } = await get("/api/health");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.healthy, true);
});

test("/api/health：无配置且 fatal 返回 503", async () => {
  // pingCache 全 false 且 getServerState fatalCount>0 且无配置 → 503
  const ctxUnhealthy = {
    store,
    logger: { info() {}, warn() {}, error() {} },
    baidu: {
      getConfig: () => ({ appDir: "/x" }),
      getLastCheckError: () => "",
      getCookie: () => null,
      listSubfolders: async () => [],
    },
    quark: { FOLDER_NAME: "n", getValidCookie: () => null, listSubfolders: async () => [] },
    xunlei: { isConnected: () => false, listSubfolders: async () => [] },
    doTransfer: async () => ({ ok: true }),
    mapLimit: async (i, n, f) => Promise.all(i.map(f)),
    extractSurl: (s) => s,
    isValidShareLink: () => true,
    refreshPings: () => {},
    pingCache: { baidu: false, quark: false, xunlei: false },
    getServerState: () => ({ healthy: false, fatalCount: 3 }),
    getVersion: () => "1.3.30",
    PORT: 3000,
    process,
    path,
    fs,
    __dirname: __dirname,
  };
  const app2 = express();
  app2.use(express.json());
  registerApiRoutes(app2, ctxUnhealthy);
  const srv2 = app2.listen(0);
  await new Promise((r) => srv2.once("listening", r));
  const port2 = srv2.address().port;
  const res = await fetch(`http://127.0.0.1:${port2}/api/health`);
  assert.strictEqual(res.status, 503, "无配置且 fatal 应返回 503");
  srv2.close();
});

test("/api/search：缺少关键词返回 400", async () => {
  const { status } = await get("/api/search");
  assert.strictEqual(status, 400);
});

test("/api/search：并行返回三盘分组结果", async () => {
  const { status, body } = await get("/api/search?q=abc");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.providers.baidu.ok, true);
  assert.strictEqual(body.providers.baidu.items[0].name, "B_abc");
  assert.strictEqual(body.providers.quark.items[0].name, "Q_abc");
  assert.strictEqual(body.providers.xunlei.items[0].name, "X_abc");
});

test("/api/search：单盘异常不拖累其他盘", async () => {
  const qf = quarkSearchImpl;
  quarkSearchImpl = async () => {
    throw new Error("夸克挂了");
  };
  const { status, body } = await get("/api/search?q=abc");
  quarkSearchImpl = qf;
  assert.strictEqual(status, 200);
  assert.strictEqual(body.providers.quark.ok, false);
  assert.strictEqual(body.providers.baidu.ok, true);
  assert.strictEqual(body.providers.xunlei.ok, true);
});

test("POST /api/trash：未知网盘返回 400", async () => {
  const { status } = await send("POST", "/api/trash", { provider: "unknown", fileIds: ["1"] });
  assert.strictEqual(status, 400);
});

test("POST /api/trash：缺少 fileIds 返回 400", async () => {
  const { status } = await send("POST", "/api/trash", { provider: "baidu" });
  assert.strictEqual(status, 400);
});

test("POST /api/trash：成功委托各盘软删", async () => {
  const r1 = await send("POST", "/api/trash", { provider: "baidu", fileIds: ["1", "2"] });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.ok, true);
  const r2 = await send("POST", "/api/trash", { provider: "quark", fileIds: ["q1"] });
  assert.strictEqual(r2.status, 200);
  const r3 = await send("POST", "/api/trash", { provider: "xunlei", fileIds: ["x1"] });
  assert.strictEqual(r3.status, 200);
});

test("/api/transfer/events：SSE 端点返回 event-stream", async () => {
  const r = await fetch(base + "/api/transfer/events?client=t-sse-1");
  assert.strictEqual(r.status, 200);
  assert.ok((r.headers.get("content-type") || "").includes("text/event-stream"));
  const reader = r.body.getReader();
  await reader.cancel();
});

test("/api/transfer/batch：带 client 时推送 step/log/done 事件（全部成功）", async () => {
  const events = [];
  const ch = progress.create("t-batch-ok");
  ch.on("event", (ev) => events.push(ev));
  doTransferImpl = async () => ({
    ok: true,
    files: [{ server_filename: "a.iso", size: 1 }],
    share: { link: "https://pan.baidu.com/s/x", password: "8888" },
  });
  const { status, body } = await send("POST", "/api/transfer/batch", {
    jobs: [{ provider: "baidu" }, { provider: "xunlei" }],
    makeShare: true,
    client: "t-batch-ok",
    title: "测试",
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.results.length, 2);
  const steps = events.filter((e) => e.type === "step");
  assert.ok(steps.length >= 4, "每任务 2 步 × 2 任务，应至少 4 条 step");
  assert.ok(
    steps.every((s) => s.step && typeof s.step.index === "number"),
    "step 应带数字 index",
  );
  const dones = events.filter((e) => e.type === "done");
  assert.strictEqual(dones.length, 1);
  assert.strictEqual(dones[0].okCount, 2);
  assert.strictEqual(dones[0].total, 2);
  assert.ok(events.filter((e) => e.type === "log").length >= 2, "应有多条日志");
  progress.remove("t-batch-ok");
});

test("/api/transfer/batch：转存失败 → step 失败 + done okCount=0", async () => {
  const events = [];
  const ch = progress.create("t-batch-fail");
  ch.on("event", (ev) => events.push(ev));
  doTransferImpl = async () => ({ ok: false, error: "链接失效" });
  const { status, body } = await send("POST", "/api/transfer/batch", {
    jobs: [{ provider: "baidu" }],
    makeShare: false,
    client: "t-batch-fail",
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.results[0].ok, false);
  const steps = events.filter((e) => e.type === "step");
  assert.ok(
    steps.some((s) => s.step.status === "失败"),
    "应有失败步骤",
  );
  const done = events.find((e) => e.type === "done");
  assert.strictEqual(done.okCount, 0);
  progress.remove("t-batch-fail");
});

test("/api/transfer：带 client 时推送 step/done 事件（成功）", async () => {
  const events = [];
  const ch = progress.create("t-single-ok");
  ch.on("event", (ev) => events.push(ev));
  doTransferImpl = async () => ({
    ok: true,
    files: [{ server_filename: "a.iso" }],
    share: { link: "https://pan.xunlei.com/s/x", password: "z" },
  });
  const { status, body } = await send("POST", "/api/transfer", {
    provider: "xunlei",
    link: "https://pan.xunlei.com/s/x",
    makeShare: true,
    client: "t-single-ok",
    title: "单条",
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "应推送 done 事件");
  assert.strictEqual(done.okCount, 1);
  assert.ok(
    events.some((e) => e.type === "step" && e.step.status === "成功"),
    "应有成功步骤",
  );
  progress.remove("t-single-ok");
});

test("/api/transfer：失败时推送失败 step + done okCount=0（400）", async () => {
  const events = [];
  const ch = progress.create("t-single-fail");
  ch.on("event", (ev) => events.push(ev));
  doTransferImpl = async () => ({ ok: false, error: "链接失效" });
  const { status, body } = await send("POST", "/api/transfer", {
    provider: "baidu",
    link: "https://pan.baidu.com/s/x",
    makeShare: true,
    client: "t-single-fail",
    title: "单条",
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(body.ok, false);
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "失败也应推送 done 事件");
  assert.strictEqual(done.okCount, 0);
  assert.ok(
    events.some((e) => e.type === "step" && e.step.status === "失败"),
    "应有失败步骤",
  );
  progress.remove("t-single-fail");
});
