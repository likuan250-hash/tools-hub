// update.test.js — 检测更新相关接口功能测试（起真实服务探 HTTP 接口）
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

test("/api/version 返回版本号与 commit", async () => {
  const r = await req("GET", "/api/version");
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.version && /^\d+\.\d+\.\d+$/.test(j.version), "version 应为 x.y.z");
  assert.ok(j.commit && /^[0-9a-f]{7,40}$/i.test(j.commit), "commit 应为 hash");
});

test("/api/check-update 返回更新状态结构", async () => {
  const r = await req("GET", "/api/check-update");
  assert.strictEqual(r.status, 200);
  const j = JSON.parse(r.body);
  assert.strictEqual(typeof j.hasUpdate, "boolean", "hasUpdate 应为布尔");
  assert.ok(j.localCommit, "应有 localCommit");
  assert.ok(j.remoteCommit, "应有 remoteCommit");
});
