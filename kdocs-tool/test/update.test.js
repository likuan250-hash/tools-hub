// update.test.js — 版本接口契约测试（起真实服务探 HTTP 接口）
// 注意：自 v0.1.13 起，kdocs-tool 不再有自更新能力（/api/check-update、/api/update、
// /api/restart 已移除），所有更新统一由工具箱 tools-hub 负责。本测试只验证版本接口。
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

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
  const port = 3900 + Math.floor(Math.random() * 100);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["index.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, KDOCS_PORT: String(port) },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await req("GET", "/api/version"); if (r.status === 200) return; }
    catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error("服务未能在 12s 内启动");
});

after(() => { if (server) server.kill(); });

test("/api/version 返回版本与来源（只读，不自更新）", async () => {
  const r = await req("GET", "/api/version");
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.version, "version 应为非空");
  assert.ok(["tools-hub", "standalone"].includes(j.source), "source 应为 tools-hub 或 standalone");
  assert.strictEqual(j.updatable, false, "updatable 应为 false");
});
