// test/account.test.js —— account.js（B站登录态）/ auth.js（扫码登录）单测
// 覆盖：账号查询（无 cookie / 无效 cookie / 有效+nav 成功 / nav 失败）、
// 二维码生成、轮询状态映射（waiting/scanned/success/expired）、cookie 落盘。
// 全部使用注入的 mock fetch，不触碰真实网络。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const account = require('../lib/account');
const auth = require('../lib/auth');

// 临时 cookie 文件助手
function writeCookieFile(obj) {
  const p = path.join(os.tmpdir(), 'biliup-acct-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('account.fetchAccount: 无 cookie 文件 → isLogin:false', async () => {
  const p = path.join(os.tmpdir(), 'biliup-noexist-' + Date.now() + '.json');
  const info = await account.fetchAccount({ cookiesPath: p });
  assert.strictEqual(info.isLogin, false);
});

test('account.fetchAccount: cookie 缺字段 → isLogin:false', async () => {
  const p = writeCookieFile({ foo: 'bar' }); // 缺 SESSDATA/bili_jct
  const info = await account.fetchAccount({ cookiesPath: p });
  assert.strictEqual(info.isLogin, false);
});

test('account.fetchAccount: 有效 cookie + nav 成功 → isLogin:true', async () => {
  const p = writeCookieFile({ SESSDATA: 'abc', bili_jct: 'xyz' });
  const fetchFn = async () => ({
    json: async () => ({ code: 0, data: { isLogin: true, uname: '测试用户', face: 'http://face', mid: 123 } }),
  });
  const info = await account.fetchAccount({ cookiesPath: p, deps: { fetchFn } });
  assert.strictEqual(info.isLogin, true);
  assert.strictEqual(info.uname, '测试用户');
  assert.strictEqual(info.face, 'http://face');
  assert.strictEqual(info.mid, 123);
});

test('account.fetchAccount: nav 抛错 → isLogin:false（不抛异常）', async () => {
  const p = writeCookieFile({ SESSDATA: 'abc', bili_jct: 'xyz' });
  const fetchFn = async () => { throw new Error('network down'); };
  const info = await account.fetchAccount({ cookiesPath: p, deps: { fetchFn } });
  assert.strictEqual(info.isLogin, false);
});

// ── 补充断言（QA 严过关）：验证「退出登录」链路中 account.invalidate() 使 5 分钟缓存真正失效。
// 这是 logout 后 /api/account 能立即反映未登录态（前端恢复二维码入口）的关键。 ──
test('account.invalidate: 使已登录缓存失效（logout 后重新查询返回未登录）', async () => {
  const p = writeCookieFile({ SESSDATA: 'abc', bili_jct: 'xyz' });
  account.invalidate(); // 清理任何历史缓存，确保从干净态开始
  // 第一次查询：nav 返回已登录，记入缓存。
  const loggedIn = async () => ({ json: async () => ({ code: 0, data: { isLogin: true } }) });
  const info1 = await account.getAccount({ cookiesPath: p, deps: { fetchFn: loggedIn } });
  assert.strictEqual(info1.isLogin, true, '首次查询应命中已登录');
  // 模拟「退出登录」调用 invalidate()。
  account.invalidate();
  // 缓存失效后第二次查询用「未登录」nav：不应再返回旧的 isLogin:true，而应重新拉取得到未登录。
  const loggedOut = async () => ({ json: async () => ({ code: 0, data: { isLogin: false } }) });
  const info2 = await account.getAccount({ cookiesPath: p, deps: { fetchFn: loggedOut } });
  assert.strictEqual(info2.isLogin, false, 'invalidate 后缓存应失效，重新查询返回未登录');
});

test('auth.generateQrcode: 返回 qrcodeKey + qrDataUrl', async () => {
  const fetchFn = async () => ({
    json: async () => ({ code: 0, data: { url: 'https://passport.bilibili.com/qrcode/xxx', qrcode_key: 'KEY123' } }),
  });
  const r = await auth.generateQrcode({ deps: { fetchFn } });
  assert.strictEqual(r.qrcodeKey, 'KEY123');
  assert.ok(typeof r.qrDataUrl === 'string' && r.qrDataUrl.length > 0, 'qrDataUrl 应为非空字符串');
});

test('auth.pollQrcode: 未扫码(86101) → waiting', async () => {
  const fetchFn = async () => ({
    headers: { getSetCookie: () => [] },
    json: async () => ({ code: 0, data: { code: 86101 } }),
  });
  const r = await auth.pollQrcode('KEY', { deps: { fetchFn } });
  assert.strictEqual(r.status, 'waiting');
});

test('auth.pollQrcode: 已扫码未确认(86090) → scanned', async () => {
  const fetchFn = async () => ({
    headers: { getSetCookie: () => [] },
    json: async () => ({ code: 0, data: { code: 86090 } }),
  });
  const r = await auth.pollQrcode('KEY', { deps: { fetchFn } });
  assert.strictEqual(r.status, 'scanned');
});

test('auth.pollQrcode: 过期(86038) → expired', async () => {
  const fetchFn = async () => ({
    headers: { getSetCookie: () => [] },
    json: async () => ({ code: 0, data: { code: 86038 } }),
  });
  const r = await auth.pollQrcode('KEY', { deps: { fetchFn } });
  assert.strictEqual(r.status, 'expired');
});

test('auth.pollQrcode: 成功(0) 解析 Set-Cookie → success + cookies', async () => {
  const fetchFn = async () => ({
    headers: {
      getSetCookie: () => [
        'SESSDATA=abc; Path=/; Domain=.bilibili.com',
        'bili_jct=xyz; Path=/',
        'DedeUserID=123; Path=/',
      ],
    },
    json: async () => ({ code: 0, data: { code: 0, message: '成功' } }),
  });
  const r = await auth.pollQrcode('KEY', { deps: { fetchFn } });
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.cookies.SESSDATA, 'abc');
  assert.strictEqual(r.cookies.bili_jct, 'xyz');
  assert.strictEqual(r.cookies.DedeUserID, '123');
});

test('auth.saveCookies: 写入对象形态 cookies.json', async () => {
  const p = path.join(os.tmpdir(), 'biliup-save-' + Date.now() + '.json');
  auth.saveCookies({ SESSDATA: 'a', bili_jct: 'b' }, { path: p });
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(obj.SESSDATA, 'a');
  assert.strictEqual(obj.bili_jct, 'b');
  fs.unlinkSync(p);
});
