// biliup-hub/test/auth.test.js —— auth.js 单测（TV 登录流程 / v0.2.4 LoginInfo）
// 全程 mock fetch，不真连 B站、不真写工作区、不真上传。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const auth = require('../lib/auth');

const webCookies = { SESSDATA: 'sess-val', bili_jct: 'jct-val', DedeUserID: '236743002' };

// ── mock fetch 构造器 ──

// 完整 TV 成功流程：auth_code → confirm(code0) → poll(code0+finalData)
function makeTvSuccessFetch(finalData, captured) {
  return async (url, init) => {
    const u = String(url);
    if (captured) captured.push({ url: u, headers: (init && init.headers) || {} });
    if (u.includes('qrcode/auth_code')) {
      return { json: async () => ({ code: 0, data: { auth_code: 'AUTH_CODE_X' } }) };
    }
    if (u.includes('h5/qrcode/confirm')) {
      return { json: async () => ({ code: 0 }) };
    }
    if (u.includes('qrcode/poll')) {
      return { json: async () => ({ code: 0, data: finalData }) };
    }
    return { json: async () => ({ code: -1 }) };
  };
}

// poll 先返回 86039（未确认），第二次返回 code0+finalData
function makeTvPollRetryFetch(finalData) {
  let polls = 0;
  return async (url) => {
    const u = String(url);
    if (u.includes('qrcode/auth_code')) {
      return { json: async () => ({ code: 0, data: { auth_code: 'AUTH_CODE_X' } }) };
    }
    if (u.includes('h5/qrcode/confirm')) {
      return { json: async () => ({ code: 0 }) };
    }
    if (u.includes('qrcode/poll')) {
      polls += 1;
      if (polls === 1) return { json: async () => ({ code: 86039 }) };
      return { json: async () => ({ code: 0, data: finalData }) };
    }
    return { json: async () => ({ code: -1 }) };
  };
}

// confirm 返回非 0（web cookie 过期等）→ 流程失败回落
function makeTvConfirmFailFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes('qrcode/auth_code')) {
      return { json: async () => ({ code: 0, data: { auth_code: 'AUTH_CODE_X' } }) };
    }
    if (u.includes('h5/qrcode/confirm')) {
      return { json: async () => ({ code: -101, message: '未登录' }) };
    }
    return { json: async () => ({ code: -1 }) };
  };
}

// ── 兜底/基础测试（保持不变）──

test('buildLoginInfoFromWebCookies: 产出 biliup 接受的 LoginInfo 结构', () => {
  const li = auth.buildLoginInfoFromWebCookies(webCookies);
  assert.ok(Array.isArray(li.cookie_info.cookies));
  assert.equal(li.cookie_info.cookies.length, 3);
  assert.deepStrictEqual(li.cookie_info.cookies[0], {
    name: 'SESSDATA', value: 'sess-val',
    domain: '.bilibili.com', path: '/',
    expires: 0, http_only: false, secure: false,
  });
  assert.ok(li.token_info && typeof li.token_info.access_token === 'string');
  assert.equal(typeof li.token_info.expires_in, 'number');
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

test('ensureLoginInfo: 兑换接口抛网络异常 → 回落本地兜底（不抛错）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_throw_' + Date.now() + '.json');
  const fetchFn = async () => { throw new Error('network down'); };
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(written.cookie_info.cookies[0].name, 'SESSDATA');
  fs.unlinkSync(tmp);
});

test('exchangeLoginInfo: web cookie 为空（无 SESSDATA/bili_jct）→ 返回 null（Catch 点：交由本地兜底拼装，且不发请求）', async () => {
  let fetchCalled = false;
  const fetchFn = async () => { fetchCalled = true; return { json: async () => ({}) }; };
  const r = await auth.exchangeLoginInfo({}, { deps: { fetchFn } });
  assert.equal(r, null);
  // header 为空时应在调用 fetch 前短路返回 null，不发起换取请求。
  assert.equal(fetchCalled, false);
});

// ── TV 登录流程测试（复刻 biliup-rs credential.rs）──

test('exchangeLoginInfo: TV 流程成功 → 返回含非空 token_info.access_token 且 platform=BiliTV 的 LoginInfo', async () => {
  const finalData = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'tv-sess' }] },
    token_info: { mid: 123, access_token: 'TV_ACCESS_TOKEN', refresh_token: 'RT', expires_in: 3600, token_created_at: 1 },
    sso: ['SESSDATA=tv-sess'],
  };
  const fetchFn = makeTvSuccessFetch(finalData);
  const r = await auth.exchangeLoginInfo(webCookies, { deps: { fetchFn } });
  assert.ok(r, 'TV 流程应成功返回 LoginInfo');
  assert.equal(r.token_info.access_token, 'TV_ACCESS_TOKEN');
  assert.ok(r.token_info.access_token.length > 0, 'access_token 不应为空');
  assert.equal(r.platform, 'BiliTV');
});

test('ensureLoginInfo: TV 流程成功 → 落盘整体等于服务端 LoginInfo（cookie_info/token_info/sso 全字段来自 TV 端）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_tv_' + Date.now() + '.json');
  const finalData = {
    cookie_info: {
      cookies: [{ name: 'SESSDATA', value: 'tv-sess' }, { name: 'bili_jct', value: 'tv-jct' }],
      domains: ['.bilibili.com'],
    },
    token_info: { mid: 123, access_token: 'TV_ACCESS_TOKEN', refresh_token: 'RT', expires_in: 3600, token_created_at: 1 },
    sso: ['SESSDATA=tv-sess', 'bili_jct=tv-jct'],
    platform: 'BiliTV',
  };
  const fetchFn = makeTvSuccessFetch(finalData);
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  // 本地兜底的 token_info 为 { mid:0, access_token:'', expires_in:0 }；若误回落，deepEqual 必失败。
  assert.deepStrictEqual(written, finalData);
  fs.unlinkSync(tmp);
});

test('sign: 已知 appkey/local_id/ts 计算 md5 与预期一致（B站接口校验关键）', () => {
  const form = { appkey: '4409e2ce8ffd12b8', local_id: '0', ts: '1700000000' };
  const body = new URLSearchParams(form).toString();
  const expected = crypto.createHash('md5').update(body + '59b43e04ad6965f34319062b478f83dd').digest('hex');
  assert.equal(auth.sign(body), expected);
  // 再与直接调用 crypto 比对一次，确保算法为小写 hex。
  assert.equal(auth.sign(body), crypto.createHash('md5').update(body + auth.TV_APPSEC).digest('hex'));
});

test('exchangeLoginInfo: web_confirm_qrcode 的 Cookie header 含 SESSDATA= 与 bili_jct=', async () => {
  const captured = [];
  const finalData = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'tv-sess' }] },
    token_info: { access_token: 'TV_ACCESS_TOKEN', expires_in: 3600 },
    sso: ['SESSDATA=tv-sess'],
  };
  const fetchFn = makeTvSuccessFetch(finalData, captured);
  await auth.exchangeLoginInfo(webCookies, { deps: { fetchFn } });
  const confirmReq = captured.find((c) => c.url.includes('h5/qrcode/confirm'));
  assert.ok(confirmReq, '应发起确认请求');
  const cookieHeader = confirmReq.headers['Cookie'] || confirmReq.headers['cookie'];
  assert.ok(cookieHeader.includes('SESSDATA='), 'Cookie 应含 SESSDATA=');
  assert.ok(cookieHeader.includes('bili_jct='), 'Cookie 应含 bili_jct=');
  assert.ok(cookieHeader.includes('sess-val'), 'Cookie 应带真实 SESSDATA 值');
  assert.ok(cookieHeader.includes('jct-val'), 'Cookie 应带真实 bili_jct 值');
});

test('exchangeLoginInfo: poll 轮询 —— 首次 86039 未确认，第二次成功返回 LoginInfo', async () => {
  const finalData = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'tv-sess' }] },
    token_info: { access_token: 'TV_ACCESS_TOKEN', expires_in: 3600 },
    sso: ['SESSDATA=tv-sess'],
  };
  // 注入即时 sleep，避免真实 1s 等待。
  const fetchFn = makeTvPollRetryFetch(finalData);
  const r = await auth.exchangeLoginInfo(webCookies, { deps: { fetchFn, sleep: async () => {} } });
  assert.ok(r, '轮询最终应成功');
  assert.equal(r.token_info.access_token, 'TV_ACCESS_TOKEN');
});

test('exchangeLoginInfo: TV 流程失败（confirm 非 0）→ 返回 null（失败安全，不抛异常，交由 ensureLoginInfo 兜底）', async () => {
  const fetchFn = makeTvConfirmFailFetch();
  let threw = false;
  let r;
  try {
    r = await auth.exchangeLoginInfo(webCookies, { deps: { fetchFn } });
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false, '不应抛异常');
  assert.equal(r, null);
});

// ── TV 各步骤失败安全 / 轮询边界（直接单测 tv* 步骤函数，补强 composite 覆盖）──
// 工程师用例只在 exchangeLoginInfo 复合层验证；这里在步骤粒度补强「失败安全」与「15 次轮询上限」契约。

// 步骤① tvGetQrcodeAuthCode
test('tvGetQrcodeAuthCode: code!=0 → null（失败安全）', async () => {
  const fetchFn = async () => ({ json: async () => ({ code: -101, message: '未登录' }) });
  assert.equal(await auth.tvGetQrcodeAuthCode(fetchFn, {}), null);
});

test('tvGetQrcodeAuthCode: code0 但缺 data.auth_code → null', async () => {
  const fetchFn = async () => ({ json: async () => ({ code: 0, data: {} }) });
  assert.equal(await auth.tvGetQrcodeAuthCode(fetchFn, {}), null);
});

test('tvGetQrcodeAuthCode: code0 + auth_code → 返回原值', async () => {
  const fetchFn = async () => ({ json: async () => ({ code: 0, data: { auth_code: 'AC1' } }) });
  assert.equal(await auth.tvGetQrcodeAuthCode(fetchFn, {}), 'AC1');
});

// 步骤② tvWebConfirmQrcode
test('tvWebConfirmQrcode: code0 → true；code!=0 → false；缺 json → false', async () => {
  const okFetch = async () => ({ json: async () => ({ code: 0 }) });
  assert.equal(await auth.tvWebConfirmQrcode(okFetch, webCookies, 'AC1'), true);
  const failFetch = async () => ({ json: async () => ({ code: -101 }) });
  assert.equal(await auth.tvWebConfirmQrcode(failFetch, webCookies, 'AC1'), false);
  const nullFetch = async () => ({ json: async () => null });
  assert.equal(await auth.tvWebConfirmQrcode(nullFetch, webCookies, 'AC1'), false);
});

// 步骤③ tvLoginByQrcode：失败安全 + 仅 86039 重试
test('tvLoginByQrcode: 未知错误码(-400) → null 且不重试（失败安全）', async () => {
  let polls = 0;
  const fetchFn = async () => { polls += 1; return { json: async () => ({ code: -400, message: '请求错误' }) }; };
  const r = await auth.tvLoginByQrcode(fetchFn, 'AC1', { sleep: async () => {} });
  assert.equal(r, null);
  assert.equal(polls, 1, '非 86039 不应重试，仅轮询 1 次');
});

test('tvLoginByQrcode: 过期码(86038) → null 且不重试', async () => {
  let polls = 0;
  const fetchFn = async () => { polls += 1; return { json: async () => ({ code: 86038 }) }; };
  const r = await auth.tvLoginByQrcode(fetchFn, 'AC1', { sleep: async () => {} });
  assert.equal(r, null);
  assert.equal(polls, 1);
});

test('tvLoginByQrcode: code0 但缺 data → null（避免返回无 token 对象）', async () => {
  const fetchFn = async () => ({ json: async () => ({ code: 0 }) });
  assert.equal(await auth.tvLoginByQrcode(fetchFn, 'AC1', { sleep: async () => {} }), null);
});

test('tvLoginByQrcode: 连续 86039 达 15 次上限 → 返回 null（无死循环）', async () => {
  let polls = 0;
  const fetchFn = async () => { polls += 1; return { json: async () => ({ code: 86039 }) }; };
  const r = await auth.tvLoginByQrcode(fetchFn, 'AC1', { sleep: async () => {} });
  assert.equal(r, null);
  assert.equal(polls, 15, '应严格轮询 15 次后停止');
});

test('tvLoginByQrcode: 第1次 86039、第2次 code0 → 成功返回含 token 的 LoginInfo', async () => {
  let polls = 0;
  const finalData = { token_info: { access_token: 'TV2', expires_in: 3600 }, cookie_info: { cookies: [] } };
  const fetchFn = async () => {
    polls += 1;
    return { json: async () => (polls === 1 ? { code: 86039 } : { code: 0, data: finalData }) };
  };
  const r = await auth.tvLoginByQrcode(fetchFn, 'AC1', { sleep: async () => {} });
  assert.ok(r, '应成功');
  assert.equal(r.token_info.access_token, 'TV2');
});

// exchangeLoginInfo 复合层：任一步抛异常 → catch 返回 null（失败安全，不向上抛）
test('exchangeLoginInfo: 任意步抛异常 → catch 返回 null（失败安全，不向上抛）', async () => {
  const fetchFn = async () => { throw new Error('boom'); };
  let threw = false;
  let r;
  try {
    r = await auth.exchangeLoginInfo(webCookies, { deps: { fetchFn } });
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false, '不应向上抛异常');
  assert.equal(r, null);
});
