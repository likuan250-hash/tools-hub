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

// ── refreshToken（access_token 自动刷新，治本 -400 鉴权失败）──

test('refreshToken: 成功用例 → 返回更新后的 loginInfo、新 token 写盘、cookie 一并续上（不污染真实磁盘）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_refresh_' + Date.now() + '.json');
  const old = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'OLD' }] },
    token_info: { access_token: 'OLD_AT', refresh_token: 'OLD_RT', expires_in: 1, token_created_at: 1 },
    sso: ['SESSDATA=OLD'],
  };
  const fetchFn = async (url, init) => {
    assert.ok(String(url).includes('/api/v2/oauth2/refresh_token'), '应使用权威 refresh_token 端点');
    const body = init && init.body;
    assert.ok(/access_key=OLD_AT/.test(body), 'body 应带旧 access_key');
    assert.ok(/refresh_token=OLD_RT/.test(body), 'body 应带旧 refresh_token');
    assert.ok(/sign=/.test(body), 'body 应带 TV 签名 sign');
    assert.ok((init.headers['Content-Type'] || '').includes('x-www-form-urlencoded'));
    return {
      json: async () => ({
        code: 0,
        data: {
          token_info: { access_token: 'NEW', refresh_token: 'NEWRT', expires_in: 2592000 },
          cookie_info: { cookies: [{ name: 'SESSDATA', value: 'X' }] },
        },
      }),
    };
  };
  const r = await auth.refreshToken(old, { path: tmp, deps: { fetchFn } });
  assert.ok(r, '应返回更新后的 loginInfo');
  assert.equal(r.token_info.access_token, 'NEW');
  assert.equal(r.token_info.refresh_token, 'NEWRT');
  assert.equal(r.token_info.expires_in, 2592000);
  assert.ok(r.token_info.token_created_at > 0, 'token_created_at 应刷新为当前时间');
  // 刷新接口顺带返回新 cookie（含新 SESSDATA），一并续上。
  assert.equal(r.cookie_info.cookies[0].value, 'X');
  assert.deepStrictEqual(r.sso, ['SESSDATA=X']);
  // 写盘验证 saveLoginInfo 被调用（用 tmpdir 避免污染真实磁盘）。
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(written.token_info.access_token, 'NEW');
  fs.unlinkSync(tmp);
});

test('refreshToken: 接口返回 code!=0 → 返回 null 且不写盘', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_refresh_fail_' + Date.now() + '.json');
  const old = { token_info: { access_token: 'A', refresh_token: 'R' } };
  const fetchFn = async () => ({ json: async () => ({ code: 1, message: 'invalid' }) });
  const r = await auth.refreshToken(old, { path: tmp, deps: { fetchFn } });
  assert.equal(r, null);
  assert.equal(fs.existsSync(tmp), false, '失败不应写盘');
});

test('refreshToken: 网络异常 → 返回 null（try/catch 兜底，不向上抛）', async () => {
  const old = { token_info: { access_token: 'A', refresh_token: 'R' } };
  const fetchFn = async () => { throw new Error('network down'); };
  let threw = false;
  let r;
  try {
    r = await auth.refreshToken(old, { path: os.tmpdir(), deps: { fetchFn } });
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false, '不应向上抛异常');
  assert.equal(r, null);
});

test('refreshToken: 缺 access_token / refresh_token → 返回 null 且不发起请求', async () => {
  let fetchCalled = false;
  const fetchFn = async () => { fetchCalled = true; return { json: async () => ({}) }; };
  assert.equal(await auth.refreshToken({}, { deps: { fetchFn } }), null);
  assert.equal(await auth.refreshToken({ token_info: {} }, { deps: { fetchFn } }), null);
  assert.equal(await auth.refreshToken({ token_info: { access_token: 'A' } }, { deps: { fetchFn } }), null);
  assert.equal(fetchCalled, false, '缺 token 不应发起请求');
});

// ── loadLoginInfo（task.js 重试刷新时读回 LoginInfo）──

test('loadLoginInfo: 存在文件 → 返回解析对象；不存在 → null', () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_load_' + Date.now() + '.json');
  const obj = { token_info: { access_token: 'A', refresh_token: 'R' } };
  fs.writeFileSync(tmp, JSON.stringify(obj));
  assert.deepStrictEqual(auth.loadLoginInfo(tmp), obj);
  assert.equal(auth.loadLoginInfo(path.join(os.tmpdir(), 'nope_' + Date.now() + '.json')), null);
  fs.unlinkSync(tmp);
});

test('loadLoginInfo: 损坏 JSON → 返回 null（失败安全，不抛异常）', () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_bad_' + Date.now() + '.json');
  fs.writeFileSync(tmp, '{not valid json');
  let threw = false;
  let r;
  try {
    r = auth.loadLoginInfo(tmp);
  } catch (e) {
    threw = true;
  }
  assert.equal(threw, false);
  assert.equal(r, null);
  fs.unlinkSync(tmp);
});

// ── 根因A 修复：ensureLoginInfo「复用优先」──

test('ensureLoginInfo: 已有未过期有效 token → 复用，不发起任何 TV 换取请求（fetchFn 计数）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_reuse_' + Date.now() + '.json');
  const now = Math.floor(Date.now() / 1000);
  const fresh = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'v' }] },
    token_info: { access_token: 'EXISTING_AT', refresh_token: 'RT', expires_in: 3600 * 24 * 30, token_created_at: now },
    sso: ['SESSDATA=v'],
  };
  fs.writeFileSync(tmp, JSON.stringify(fresh));
  let fetchCount = 0;
  const fetchFn = async () => { fetchCount++; return { json: async () => ({}) }; };
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp, '应返回同一路径（直接复用）');
  assert.equal(fetchCount, 0, '复用有效 token 时不应发起任何 TV 请求');
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(written.token_info.access_token, 'EXISTING_AT', '应保留原有效 token，未被重换覆盖');
  fs.unlinkSync(tmp);
});

test('ensureLoginInfo: token 已过期 → 重新发起 TV 换取并落盘新 token', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_expired_' + Date.now() + '.json');
  const old = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'old' }] },
    token_info: { access_token: 'OLD_AT', refresh_token: 'RT', expires_in: 3600, token_created_at: 1 }, // token_created_at=1 很久以前 → 过期
    sso: ['SESSDATA=old'],
  };
  fs.writeFileSync(tmp, JSON.stringify(old));
  const finalData = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'tv-sess' }] },
    token_info: { access_token: 'NEW_TV_AT', refresh_token: 'NEWRT', expires_in: 3600 * 24 * 30, token_created_at: Math.floor(Date.now() / 1000) },
    sso: ['SESSDATA=tv-sess'],
  };
  let exchanged = false;
  const tvFetch = makeTvSuccessFetch(finalData);
  const fetchFn = async (url) => {
    if (String(url).includes('qrcode/auth_code')) exchanged = true;
    return tvFetch(url);
  };
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp);
  assert.equal(exchanged, true, '过期 token 应触发 TV 换取');
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(written.token_info.access_token, 'NEW_TV_AT', '过期 token 应被重新换取的新 token 覆盖');
  fs.unlinkSync(tmp);
});

test('ensureLoginInfo: 兜底空 token（access_token 为空）→ 仍走 TV 换取（排除空 token 复用）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_empty_' + Date.now() + '.json');
  const emptyTok = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'x' }] },
    token_info: { access_token: '', refresh_token: '', expires_in: 0, token_created_at: 0 },
    sso: ['SESSDATA=x'],
  };
  fs.writeFileSync(tmp, JSON.stringify(emptyTok));
  const finalData = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'tv-sess' }] },
    token_info: { access_token: 'EXCHANGED_AT', refresh_token: 'RT', expires_in: 3600 * 24 * 30, token_created_at: Math.floor(Date.now() / 1000) },
    sso: ['SESSDATA=tv-sess'],
  };
  let exchanged = false;
  const tvFetch = makeTvSuccessFetch(finalData);
  const fetchFn = async (url) => {
    if (String(url).includes('qrcode/auth_code')) exchanged = true;
    return tvFetch(url);
  };
  const p = await auth.ensureLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp);
  assert.equal(exchanged, true, '空 token 应触发 TV 换取，不得复用');
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(written.token_info.access_token, 'EXCHANGED_AT', '应落盘换取得到的新 token');
  fs.unlinkSync(tmp);
});

test('isLoginInfoFresh: 各边界判定', () => {
  const now = 1_000_000;
  // 空 token → false（排除兜底空 token 复用）
  assert.equal(auth.isLoginInfoFresh({ token_info: { access_token: '', expires_in: 9999, token_created_at: now } }), false);
  // null / 无 token_info → false
  assert.equal(auth.isLoginInfoFresh(null), false);
  assert.equal(auth.isLoginInfoFresh({}), false);
  // expires_in<=0 且 access_token 非空 → 视为长期有效，true
  assert.equal(auth.isLoginInfoFresh({ token_info: { access_token: 'X', expires_in: 0, token_created_at: 0 } }), true);
  // 正常：剩余远大于缓冲 → true
  assert.equal(auth.isLoginInfoFresh(
    { token_info: { access_token: 'X', expires_in: 3600 * 24 * 30, token_created_at: now } },
    { now, safeBufferSeconds: 6 * 3600 },
  ), true);
  // 临期：剩余 < 缓冲 → false
  assert.equal(auth.isLoginInfoFresh(
    { token_info: { access_token: 'X', expires_in: 3600, token_created_at: now } },
    { now, safeBufferSeconds: 6 * 3600 },
  ), false);
  // 已过期 → false
  assert.equal(auth.isLoginInfoFresh(
    { token_info: { access_token: 'X', expires_in: 100, token_created_at: now - 1000 } },
    { now, safeBufferSeconds: 6 * 3600 },
  ), false);
  // expires_in>0 但 token_created_at 缺失(0) → 无法判定，false
  assert.equal(auth.isLoginInfoFresh(
    { token_info: { access_token: 'X', expires_in: 9999, token_created_at: 0 } },
    { now, safeBufferSeconds: 6 * 3600 },
  ), false);
});

// ── 根因C 修复 + 失败明确化：ensureFreshLoginInfo（上传前主动续期）──

test('ensureFreshLoginInfo: 临期 token → 主动 refreshToken 成功后复用（不重换、写回新 token）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_refresh_trigger_' + Date.now() + '.json');
  const now = Math.floor(Date.now() / 1000);
  const nearExpiry = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'v' }] },
    token_info: { access_token: 'OLD_AT', refresh_token: 'OLD_RT', expires_in: 3600, token_created_at: now - 3600 }, // 已过期
    sso: ['SESSDATA=v'],
  };
  fs.writeFileSync(tmp, JSON.stringify(nearExpiry));
  let refreshEndpointHit = false;
  let exchangeCalled = false;
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('/api/v2/oauth2/refresh_token')) {
      refreshEndpointHit = true;
      return { json: async () => ({ code: 0, data: { token_info: { access_token: 'REFRESHED_AT', refresh_token: 'NEWRT', expires_in: 3600 * 24 * 30 } } }) };
    }
    if (u.includes('passport-tv-login')) exchangeCalled = true;
    return { json: async () => ({ code: -1 }) };
  };
  const p = await auth.ensureFreshLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp);
  assert.equal(refreshEndpointHit, true, '临期应触发 refresh');
  assert.equal(exchangeCalled, false, 'refresh 成功不应再走 TV 换取');
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(written.token_info.access_token, 'REFRESHED_AT', '应写回刷新后的新 token');
  fs.unlinkSync(tmp);
});

test('ensureFreshLoginInfo: 已有新鲜 token → 直接复用，不 refresh 不重换', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_fresh_' + Date.now() + '.json');
  const now = Math.floor(Date.now() / 1000);
  const fresh = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'v' }] },
    token_info: { access_token: 'CUR_AT', refresh_token: 'RT', expires_in: 3600 * 24 * 30, token_created_at: now },
    sso: ['SESSDATA=v'],
  };
  fs.writeFileSync(tmp, JSON.stringify(fresh));
  let anyHit = false;
  const fetchFn = async (url) => { anyHit = true; return { json: async () => ({ code: -1 }) }; };
  const p = await auth.ensureFreshLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp);
  assert.equal(anyHit, false, '新鲜 token 应直接复用，不发任何请求');
  fs.unlinkSync(tmp);
});

test('ensureFreshLoginInfo: refresh 失败 → 回退 TV 换取（exchange）', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_refresh_fallback_' + Date.now() + '.json');
  const now = Math.floor(Date.now() / 1000);
  const nearExpiry = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'v' }] },
    token_info: { access_token: 'OLD_AT', refresh_token: 'OLD_RT', expires_in: 3600, token_created_at: now - 3600 },
    sso: ['SESSDATA=v'],
  };
  fs.writeFileSync(tmp, JSON.stringify(nearExpiry));
  const finalData = {
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'tv-sess' }] },
    token_info: { access_token: 'EXCHANGED_AT', refresh_token: 'RT', expires_in: 3600 * 24 * 30, token_created_at: Math.floor(Date.now() / 1000) },
    sso: ['SESSDATA=tv-sess'],
  };
  let refreshEndpointHit = false;
  let exchangeCalled = false;
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('/api/v2/oauth2/refresh_token')) { refreshEndpointHit = true; return { json: async () => ({ code: 1, message: 'invalid' }) }; } // refresh 失败
    if (u.includes('passport-tv-login')) { exchangeCalled = true; return makeTvSuccessFetch(finalData)(u); }
    return { json: async () => ({ code: -1 }) };
  };
  const p = await auth.ensureFreshLoginInfo(webCookies, { path: tmp, deps: { fetchFn } });
  assert.equal(p, tmp);
  assert.equal(refreshEndpointHit, true, '应尝试 refresh');
  assert.equal(exchangeCalled, true, 'refresh 失败应回退 TV 换取');
  const written = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.equal(written.token_info.access_token, 'EXCHANGED_AT', '应落盘换取得到的新 token');
  fs.unlinkSync(tmp);
});

test('ensureFreshLoginInfo: web cookie 无效 + 无可用 token → 抛清晰错误「登录态失效,请重新扫码」', async () => {
  const tmp = path.join(os.tmpdir(), 'biliup_li_allfail_' + Date.now() + '.json');
  // 已有兜底空 token（access_token 空，无 refresh_token）→ refresh 跳过；
  // web cookie 无效（无 SESSDATA）→ exchange 短路返回 null → buildLoginInfoFromWebCookies 又产出空 token → 最终抛错。
  const emptyTok = {
    cookie_info: { cookies: [] },
    token_info: { access_token: '', refresh_token: '', expires_in: 0, token_created_at: 0 },
    sso: [],
  };
  fs.writeFileSync(tmp, JSON.stringify(emptyTok));
  let threw = false;
  let errMsg = '';
  try {
    await auth.ensureFreshLoginInfo({}, { path: tmp, deps: { fetchFn: async () => ({ json: async () => ({ code: -1 }) }) } });
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  assert.equal(threw, true, '拿不到有效 token 应抛错');
  assert.ok(/登录态失效/.test(errMsg) && /扫码/.test(errMsg),
    '错误信息应直白指出登录态失效请重新扫码，实际: ' + errMsg);
  fs.unlinkSync(tmp);
});
