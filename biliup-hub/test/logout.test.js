// biliup-hub/test/logout.test.js —— 退出登录 / 清除登录态单测
// 1) clearSession（mock fs）：删除 cookies.json + login_info.json、缺文件不报错、返回 cleared 列表、unlink 异常不冒泡。
// 2) POST /api/logout 集成（真实临时目录）：验证路由删除凭证并仅删凭证（不动 config.json）。
// 全部避免触碰真实用户数据目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require('../lib/store') 与 require('../server') 之前设定数据目录，
// 因为 store 在首次 getConfig 时惰性读取 BILIUP_DATA_DIR。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-logout-'));
process.env.BILIUP_DATA_DIR = TMP;

const store = require('../lib/store');
const auth = require('../lib/auth');
const app = require('../server');

function startServer() {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function postJSON(srv, p) {
  const port = srv.address().port;
  const resp = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST' });
  return { status: resp.status, body: await resp.json() };
}

// ── clearSession：mock fs 单测 ──
test('clearSession: 两个凭证文件均存在 → 全部删除，cleared 含两路径', () => {
  const deleted = [];
  const mockFs = {
    existsSync: () => true,
    unlinkSync: (p) => { deleted.push(p); },
  };
  const r = auth.clearSession({ fs: mockFs });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.cleared.sort(), [store.getCookiesPath(), store.getLoginInfoPath()].sort());
  assert.strictEqual(deleted.length, 2);
});

test('clearSession: 文件不存在 → 不调用 unlink、cleared 为空、不报错', () => {
  let unlinkCalled = false;
  const mockFs = {
    existsSync: () => false,
    unlinkSync: () => { unlinkCalled = true; },
  };
  const r = auth.clearSession({ fs: mockFs });
  assert.strictEqual(unlinkCalled, false);
  assert.deepStrictEqual(r.cleared, []);
  assert.strictEqual(r.ok, true);
});

test('clearSession: 仅 login_info.json 存在 → 仅删该文件', () => {
  const loginPath = store.getLoginInfoPath();
  const deleted = [];
  const mockFs = {
    existsSync: (p) => p === loginPath,
    unlinkSync: (p) => { deleted.push(p); },
  };
  const r = auth.clearSession({ fs: mockFs });
  assert.deepStrictEqual(r.cleared, [loginPath]);
  assert.strictEqual(deleted.length, 1);
});

test('clearSession: unlink 抛错 → 捕获、ok 仍为 true、cleared 不含失败文件', () => {
  const cookiePath = store.getCookiesPath();
  const deleted = [];
  const mockFs = {
    existsSync: () => true,
    unlinkSync: (p) => {
      if (p === cookiePath) throw new Error('permission denied');
      deleted.push(p);
    },
  };
  const r = auth.clearSession({ fs: mockFs });
  assert.strictEqual(r.ok, true);
  // cookies 删除失败不应进入 cleared；login_info.json 仍被删除。
  assert.deepStrictEqual(r.cleared, [store.getLoginInfoPath()]);
});

// ── POST /api/logout 集成（真实临时目录）──
test('POST /api/logout 集成：删除 cookies.json + login_info.json 且返回 ok（不动 config.json）', async () => {
  const cookiePath = store.getCookiesPath();
  const loginPath = store.getLoginInfoPath();
  const configPath = store.CONFIG_FILE;
  fs.writeFileSync(cookiePath, JSON.stringify({ SESSDATA: 'a', bili_jct: 'b' }), 'utf8');
  fs.writeFileSync(loginPath, JSON.stringify({ cookie_info: {} }), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({ foo: 'bar' }), 'utf8');

  const srv = await startServer();
  try {
    const { status, body } = await postJSON(srv, '/api/logout');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepStrictEqual(body.cleared.sort(), [cookiePath, loginPath].sort());
    assert.equal(fs.existsSync(cookiePath), false, 'cookies.json 应已被删除');
    assert.equal(fs.existsSync(loginPath), false, 'login_info.json 应已被删除');
    assert.equal(fs.existsSync(configPath), true, 'config.json 不应被删除');
  } finally {
    srv.close();
  }
});

// ── 补充断言（QA 严过关）：用户已退出/文件本就不存在的最真实场景 ──
test('POST /api/logout 集成（文件不存在）：返回 ok 且 cleared 为空、不凭空创建凭证、config.json 不受影响', async () => {
  // 确保 cookie/login_info 文件此刻不存在（真实「已退出/从未登录」态）。
  const cookiePath = store.getCookiesPath();
  const loginPath = store.getLoginInfoPath();
  for (const p of [cookiePath, loginPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  // 仅留 config.json，验证其不被删除也不被改动。
  const configPath = store.CONFIG_FILE;
  fs.writeFileSync(configPath, JSON.stringify({ keep: 'me' }), 'utf8');

  assert.equal(fs.existsSync(cookiePath), false, '前置：cookies.json 不应存在');
  assert.equal(fs.existsSync(loginPath), false, '前置：login_info.json 不应存在');

  const srv = await startServer();
  try {
    const { status, body } = await postJSON(srv, '/api/logout');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepStrictEqual(body.cleared, [], '文件不存在时 cleared 应为空数组');
    assert.equal(fs.existsSync(configPath), true, 'config.json 仍应存在');
    assert.equal(fs.existsSync(cookiePath), false, '不应凭空创建 cookies.json');
    assert.equal(fs.existsSync(loginPath), false, '不应凭空创建 login_info.json');
  } finally {
    srv.close();
  }
});
