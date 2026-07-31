// biliup-hub/test/auth.test.js —— auth.js 单测（v0.2.4 LoginInfo / token 换取）
// 全程 mock fetch，不真连 B站、不真写工作区、不真上传。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../lib/auth');

const webCookies = { SESSDATA: 'sess-val', bili_jct: 'jct-val', DedeUserID: '236743002' };

test('buildLoginInfoFromWebCookies: 产出 biliup 接受的 LoginInfo 结构', () => {
  const li = auth.buildLoginInfoFromWebCookies(webCookies);
  // cookie_info.cookies 由 web cookie 逐项生成（name/value）。
  assert.ok(Array.isArray(li.cookie_info.cookies));
  assert.equal(li.cookie_info.cookies.length, 3);
  assert.deepStrictEqual(li.cookie_info.cookies[0], {
    name: 'SESSDATA', value: 'sess-val',
    domain: '.bilibili.com', path: '/',
    expires: 0, http_only: false, secure: false,
  });
  // token_info 至少含 access_token / expires_in（biliup 解析必需字段）。
  assert.ok(li.token_info && typeof li.token_info.access_token === 'string');
  assert.equal(typeof li.token_info.expires_in, 'number');
  // sso 为 "name=value" 数组。
  assert.deepStrictEqual(li.sso, ['SESSDATA=sess-val', 'bili_jct=jct-val', 'DedeUserID=236743002']);
});

test('ensureLoginInfo: 兑换接口失败 → 本地兜底拼装并落盘到指定 path（不写工作区）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_fallback_' + Date.now() + '.json');
  const fetchFn = async () => ({ json: async () => ({ code: -101, message: '未登录' }) });
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp);
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.ok(written.cookie_info && Array.isArray(written.cookie_info.cookies));
  assert.equal(written.cookie_info.cookies[0].name, 'SESSDATA');
  assert.ok(written.token_info && 'access_token' in written.token_info);
  fs.unlinkSync(tmp);
});

test('ensureLoginInfo: 兑换接口成功 → 使用服务端 LoginInfo（含真实 app token）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_exchange_' + Date.now() + '.json');
  const serverLoginInfo = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'real' }] },
    token_info: { access_token: 'APP_TOKEN', expires_in: 123 },
    sso: ['SESSDATA=real'],
  };
  const fetchFn = async () => ({ json: async () => ({ code: 0, data: serverLoginInfo }) });
  const p = await auth.ensureLoginInfo({ SESSDATA: 's' }, { path: tmp, deps: { fetchFn } });
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(written.token_info.access_token, 'APP_TOKEN');
  fs.unlinkSync(tmp);
});

test('ensureLoginInfo: 兑换接口抛网络异常 → 回落本地兜底（不抛错）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_throw_' + Date.now() + '.json');
  const fetchFn = async () => { throw new Error('network down'); };
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(written.cookie_info.cookies[0].name, 'SESSDATA');
  fs.unlinkSync(tmp);
});

// ── 补充断言（QA 严过关）：强化「兑换成功用服务端」与「空 cookie 回落」两个关键分支 ──

test('ensureLoginInfo: 兑换成功 → 落盘整体等于服务端 LoginInfo（cookie_info/token_info/sso 全字段均来自服务端，非本地兜底）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_whole_' + Date.now() + '.json');
  const serverLoginInfo = {
    cookie_info: {
      cookies: [{ name: 'SESSDATA', value: 'real' }, { name: 'bili_jct', value: 'real-jct' }],
      domains: ['.bilibili.com'],
    },
    token_info: { mid: 123, access_token: 'APP_TOKEN', refresh_token: 'RT', expires_in: 123, token_created_at: 999 },
    sso: ['SESSDATA=real', 'bili_jct=real-jct'],
  };
  // 本地兜底的 token_info 为 { mid:0, access_token:'', expires_in:0 }；若误回落，deepEqual 必失败。
  const fetchFn = async () => ({ json: async () => ({ code: 0, data: serverLoginInfo }) });
  const p = await auth.ensureLoginInfo({ SESSDATA: 's', bili_jct: 'j' }, { path: tmp, deps: { fetchFn } });
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepStrictEqual(written, serverLoginInfo);
  fs.unlinkSync(tmp);
});

test('exchangeLoginInfo: web cookie 为空（无 SESSDATA/bili_jct）→ 返回 null（Catch 点：交由本地兜底拼装）', async () => {
  let fetchCalled = false;
  const fetchFn = async () => { fetchCalled = true; return { json: async () => ({}) }; };
  const r = await auth.exchangeLoginInfo({}, { deps: { fetchFn } });
  assert.equal(r, null);
  // header 为空时应在调用 fetch 前短路返回 null，不发起换取请求。
  assert.equal(fetchCalled, false);
});
