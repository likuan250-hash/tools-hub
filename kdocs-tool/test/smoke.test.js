// smoke.test.js — 起真实服务探 HTTP 接口（不依赖外部 kdocs/bl，只测 /api/version 与 /api/parse）
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

// 本文件起真实 express 服务探接口。若子包未安装依赖（express 缺失），
// 优雅跳过而非硬崩——CI 中已 npm install，照常实跑；本地缺依赖时不打断其它测试。
const hasExpress = (() => { try { require.resolve("express"); return true; } catch { return false; } })();
const t = hasExpress ? test : test.skip;

let server, base;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, {
      method, headers: data ? { "Content-Type": "application/json" } : {},
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  if (!hasExpress) return;
  const port = 3700 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, KDOCS_PORT: String(port) },
    stdio: "ignore",
  });
  // 等待服务就绪（轮询 /api/version）
  for (let i = 0; i < 60; i++) {
    try { const r = await req("GET", "/api/version"); if (r.status === 200) return; }
    catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error("服务未能在 12s 内启动");
});

after(() => { if (server) server.kill(); });

t("GET /api/version 返回版本与来源（只读，不自更新）", async () => {
  const r = await req("GET", "/api/version");
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.version, "应有 version 字段");
  assert.ok(["tools-hub", "standalone"].includes(j.source), "source 应为 tools-hub 或 standalone");
  assert.strictEqual(j.updatable, false, "updatable 应为 false");
});

t("POST /api/parse 解析游戏名与网盘链接", async () => {
  const r = await req("POST", "/api/parse", {
    text: "双影奇境（Split Fiction）Build.18353366 (v20250527) 官方中文+联机补丁 免安装硬盘版\n夸克：https://pan.quark.cn/s/abc123",
  });
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.gameName, "双影奇境");
  assert.strictEqual(j.englishName, "Split Fiction");
  assert.strictEqual(j.quarkUrl, "https://pan.quark.cn/s/abc123");
});
