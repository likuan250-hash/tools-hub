const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("../server");

async function withServer(fn, options = {}) {
  const { server, state } = createServer({ port: 0, templateDrt: __filename, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, state, server });
  } finally {
    state.run = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/version：返回 resolve-hub 与 bootToken", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(base + "/api/version");
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.source, "resolve-hub");
    assert.ok(j.version);
    assert.ok("bootToken" in j);
  });
});

test("GET /api/preflight：返回 python/template/resolveExe/materialRoot", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(base + "/api/preflight");
    const j = await r.json();
    assert.ok(j.python && typeof j.python.ok === "boolean");
    assert.ok(j.template && j.template.ok === true, "测试注入的模板文件应存在");
    assert.ok(j.resolveExe && "ok" in j.resolveExe);
    assert.ok(typeof j.materialRoot === "string");
  });
});

test("跨站 Origin：POST 被 403 拒绝", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(base + "/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ dir: os.tmpdir() }),
    });
    assert.strictEqual(r.status, 403);
  });
});

test("POST /api/start：目录不存在 → 400", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(base + "/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ dir: path.join(os.tmpdir(), "definitely-not-exist-" + Date.now()) }),
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /素材目录/);
  });
});

test("POST /api/render：缺项目名 → 400", async () => {
  await withServer(async ({ base }) => {
    const r = await fetch(base + "/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ out: "x" }),
    });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /项目名/);
  });
});

test("并发锁：已有任务时再次 start → 409", async () => {
  await withServer(async ({ base, state }) => {
    state.run = { kind: "setup", child: { pid: 0 }, startedAt: Date.now() };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-hub-dir-"));
    const r = await fetch(base + "/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir }),
    });
    assert.strictEqual(r.status, 409);
    assert.match((await r.json()).error, /已有任务/);
  });
});

test("POST /api/cancel：没有任务 → ok:false；有任务 → 返回 cancelled", async () => {
  await withServer(async ({ base, state }) => {
    let r = await fetch(base + "/api/cancel", { method: "POST" });
    assert.strictEqual((await r.json()).ok, false);
    state.run = { kind: "render", child: { pid: 0 }, startedAt: Date.now() };
    r = await fetch(base + "/api/cancel", { method: "POST" });
    assert.strictEqual((await r.json()).cancelled, true);
  });
});

test("GET /api/status：反映任务锁", async () => {
  await withServer(async ({ base, state }) => {
    let j = await (await fetch(base + "/api/status")).json();
    assert.strictEqual(j.busy, false);
    state.run = { kind: "render", child: { pid: 0 }, startedAt: Date.now() - 5000 };
    j = await (await fetch(base + "/api/status")).json();
    assert.strictEqual(j.busy, true);
    assert.strictEqual(j.kind, "render");
    assert.ok(j.elapsedSec >= 5);
  });
});
