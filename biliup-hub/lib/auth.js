// lib/auth.js —— B站扫码登录（#7，自实现，不依赖 biliup.exe 终端输出）
//
// 说明（偏离说明，见报告）：biliup-rs 的 `login` 子命令会把二维码往终端打 ASCII，
// 无法干净地传给浏览器渲染；且其登录态最终也落在本工具的 cookies.json。
// 故这里直接调用 B站官方扫码登录 API（与 biliup 底层同一套机制）：
//   1) generate 取 qrcode_key + 二维码内容 url
//   2) 后端用 qrcode 库把 url 渲染成 PNG dataURL 交给前端 <img> 展示
//   3) poll 轮询状态；成功后从 Set-Cookie 取出 SESSDATA/bili_jct 等写入 BILIUP_DATA_DIR/cookies.json
//
// 【v0.2.4 适配】biliup 的 -u 要求自己的 LoginInfo 结构（含 cookie_info/token_info/sso）。
// 经实测：原 web/cookie/info 兑换接口只返回 {refresh:false,timestamp}，不返回 token（根因），
// 导致生成的 access_token 为空 → 上传报 code=-400 鉴权失败，用户重登无效。
// 改为复刻 biliup-rs credential.rs 的 TV 登录流程：用已有的 web 登录态（SESSDATA+bili_jct）
// 静默自动确认一个 TV 登录二维码，从而拿到 TV 端真正的 access_token（用户视角仍只扫一次 web 码）。
// 流程：get_qrcode → web_confirm_qrcode → login_by_qrcode（轮询）。任何一步失败回落本地兜底拼装。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const logger = require('./logger');
const cookies = require('./cookies');
const secret = require('./crypto');

const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'; // cookie 有效性验证
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1';
const REFERER = 'https://passport.bilibili.com/';

// ── TV 登录流程常量（复刻 biliup-rs AppKeyStore::BiliTV / credential.rs）──
const TV_APPKEY = '4409e2ce8ffd12b8';
const TV_APPSEC = '59b43e04ad6965f34319062b478f83dd';
const TV_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:38.0) Gecko/20100101 Firefox/38.0 Iceweasel/38.2.1 BiliApp';
const PASSPORT = 'https://passport.bilibili.com';

// 登录态复用安全缓冲：剩余有效期 > 该值才视为「新鲜可复用」，避免在有效期边缘仍去换取/上传导致 -400。
// 选 6 小时：TV access_token 过期前预留足够时间完成一次投稿，避免「刚复用就过期」。
const LOGIN_INFO_SAFE_BUFFER_SECONDS = 6 * 60 * 60;

// qrcode 库（可选依赖）；缺失时回退到第三方图床生成二维码图。
let _qrcode;
try { _qrcode = require('qrcode'); } catch (e) { _qrcode = null; }

let _fetch;
function getFetch() {
  if (_fetch) return _fetch;
  try { _fetch = require('undici').fetch; } catch (e) { _fetch = (globalThis.fetch || global.fetch); }
  return _fetch;
}

/**
 * 计算 B站接口签名（复刻 biliup-rs credential.rs 的 sign）。
 * sign = md5(param + TV_APPSEC)，小写 hex（对应 Rust 的 {:x}）。
 * @param {string} param 已按 key=value&... 拼接的请求体
 * @returns {string} 32 位小写 md5 hex
 */
function sign(param) {
  return crypto.createHash('md5').update(param + TV_APPSEC).digest('hex');
}

/**
 * 延时工具；deps.sleep 可注入（单测），不存在则回退 setTimeout。
 * @param {number} ms
 * @param {Object} [deps] 通常取 opts.deps
 * @returns {Promise<void>}
 */
function sleep(ms, deps) {
  if (deps && typeof deps.sleep === 'function') return deps.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 申请二维码。
 * @param {{deps?:Object}} [opts] opts.deps.fetchFn 可注入（单测）
 * @returns {Promise<{qrcodeKey:string, qrDataUrl:string}>}
 */
async function generateQrcode(opts = {}) {
  const deps = opts.deps || {};
  const fetchFn = deps.fetchFn || getFetch();
  const url = GEN_URL + '?source=main-fe-header&go_url=' + encodeURIComponent('https://www.bilibili.com/');
  const resp = await fetchFn(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
  });
  const json = await resp.json();
  if (!json || json.code !== 0 || !json.data || !json.data.qrcode_key) {
    throw new Error('二维码生成失败: ' + ((json && json.message) || resp.status));
  }
  const qrcodeKey = json.data.qrcode_key;
  const qrContent = json.data.url; // 二维码内容（登录页面 url）
  let qrDataUrl;
  if (_qrcode && typeof _qrcode.toDataURL === 'function') {
    qrDataUrl = await _qrcode.toDataURL(qrContent, { width: 240, margin: 1 });
  } else {
    // 回退：用第三方二维码图床（需联网；登录本身也需联网）
    qrDataUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(qrContent);
  }
  return { qrcodeKey, qrDataUrl };
}

/**
 * 解析 Set-Cookie 头，提取 cookie 键值对（取每个 Set-Cookie 的首个 name=value）。
 * @param {Array<string>} setCookieHeaders
 * @returns {Object}
 */
function parseSetCookie(setCookieHeaders) {
  const out = {};
  for (const header of (setCookieHeaders || [])) {
    const m = String(header).match(/([^=;]+)=([^;]*)/);
    if (m) {
      const name = m[1].trim();
      const value = m[2];
      if (name && !out[name]) out[name] = value;
    }
  }
  return out;
}

/**
 * 轮询扫码状态。
 * @param {string} key qrcode_key
 * @param {{deps?:Object}} [opts] opts.deps.fetchFn 可注入（单测）
 * @returns {Promise<{status:'waiting'|'scanned'|'success'|'expired', cookies?:Object}>}
 */
async function pollQrcode(key, opts = {}) {
  const deps = opts.deps || {};
  const fetchFn = deps.fetchFn || getFetch();
  const url = POLL_URL + '?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header';
  const resp = await fetchFn(url, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER },
  });

  // 读取 Set-Cookie（登录成功时返回 SESSDATA/bili_jct 等）
  let cookiesObj = {};
  try {
    const sc = (typeof resp.headers.getSetCookie === 'function')
      ? resp.headers.getSetCookie()
      : (resp.headers.raw ? (resp.headers.raw()['set-cookie'] || []) : []);
    cookiesObj = parseSetCookie(sc);
  } catch (e) { /* 忽略解析失败 */ }

  const json = await resp.json();
  const code = json && json.data && typeof json.data.code === 'number' ? json.data.code : (json && json.code);

  if (code === 0) {
    return { status: 'success', cookies: cookiesObj };
  }
  if (code === 86090) {
    return { status: 'scanned' }; // 已扫码，待确认
  }
  if (code === 86101 || code === 86039) {
    return { status: 'waiting' }; // 未扫码
  }
  // 86038 等：过期 / 失效
  return { status: 'expired' };
}

/**
 * 验证扁平 web cookie 是否有效（扫码登录后自动校验，防「显示登录成功但实际投稿 -412」）。
 * 调 B站 nav 接口：code=0 且 isLogin=true → 有效（顺带取 uname/mid）；-101 → 登录态无效；网络异常 → ok:false。
 * @param {Object} cookiesObj 扁平 web cookie（含 SESSDATA/bili_jct）
 * @param {{deps?:Object}} [opts] opts.deps.fetchFn 可注入（单测）
 * @returns {Promise<{ok:boolean, code:number, uname?:string, mid?:number, message:string}>}
 */
async function verifyCookies(cookiesObj, opts = {}) {
  const deps = opts.deps || {};
  const fetchFn = deps.fetchFn || getFetch();
  if (!cookiesObj || !cookiesObj.SESSDATA) {
    return { ok: false, code: -101, message: '缺少 SESSDATA（cookie 不完整）' };
  }
  const cookieStr = Object.keys(cookiesObj)
    .filter((k) => cookiesObj[k] != null && String(cookiesObj[k]) !== '')
    .map((k) => `${k}=${cookiesObj[k]}`)
    .join('; ');
  try {
    const resp = await fetchFn(NAV_URL, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/', 'Cookie': cookieStr },
    });
    const json = await resp.json();
    if (json && json.code === 0 && json.data && json.data.isLogin) {
      return { ok: true, code: 0, uname: json.data.uname, mid: json.data.mid, message: '登录态有效' };
    }
    const code = json && typeof json.code === 'number' ? json.code : -1;
    return { ok: false, code, message: (json && json.message) || '登录态无效' };
  } catch (e) {
    return { ok: false, code: -1, message: '网络异常: ' + ((e && e.message) || e) };
  }
}

/**
 * 将登录得到的 cookies 写入 BILIUP_DATA_DIR/cookies.json（与投稿上传同一份）。
 * @param {Object} cookiesObj
 * @param {{path?:string}} [opts] opts.path 覆盖写入路径（单测用）
 */
function saveCookies(cookiesObj, opts = {}) {
  const p = opts.path || store.getCookiesPath();
  cookies.save(p, cookiesObj); // AES-256-GCM 加密落盘，磁盘上不再有明文 SESSDATA
  logger.info('[auth] 登录 cookie 已写入', p);
  return p;
}

/**
 * 将扁平 web cookie 本地拼装成 biliup v0.2.4 的 LoginInfo 结构（兜底用）。
 * 经验证（bin/biliup.exe -u <本结构> upload）该结构可被正确解析：
 *   cookie_info.cookies[] 仅需 name/value；token_info 需 access_token + expires_in；
 *   sso 为 "name=value" 数组；domains 可选。空 token_info 在 client 提交接口下可用。
 * @param {Object} webCookies 扁平 web cookie 对象（含 SESSDATA/bili_jct 等）
 * @returns {Object} biliup LoginInfo
 */
function buildLoginInfoFromWebCookies(webCookies) {
  const entries = Object.keys(webCookies || {})
    .filter((k) => webCookies[k] != null && String(webCookies[k]) !== '')
    .map((k) => ({ name: k, value: String(webCookies[k]) }));
  const cookiesArr = entries.map((e) => ({
    name: e.name,
    value: e.value,
    domain: '.bilibili.com',
    path: '/',
    expires: 0,
    http_only: false,
    secure: false,
  }));
  const sso = entries.map((e) => e.name + '=' + e.value);
  return {
    cookie_info: {
      cookies: cookiesArr,
      domains: ['.bilibili.com'],
    },
    token_info: {
      mid: 0,
      access_token: '',
      refresh_token: '',
      expires_in: 0,
      token_created_at: 0,
    },
    sso: sso,
  };
}

/**
 * TV 登录流程第①步：申请 TV auth_code。
 * 复刻 biliup-rs credential.rs 的 get_qrcode。
 * @param {Function} fetchFn
 * @param {Object} deps
 * @returns {Promise<string|null>} 成功返回 auth_code，失败返回 null
 */
async function tvGetQrcodeAuthCode(fetchFn, deps) {
  const ts = String(Math.floor(Date.now() / 1000));
  const form = { appkey: TV_APPKEY, local_id: '0', ts };
  const body = new URLSearchParams(form).toString();
  const sign1 = sign(body);
  const resp = await fetchFn(`${PASSPORT}/x/passport-tv-login/qrcode/auth_code`, {
    method: 'POST',
    headers: { 'User-Agent': TV_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({}, form, { sign: sign1 })).toString(),
  });
  const json = await resp.json();
  if (!json || json.code !== 0 || !json.data || !json.data.auth_code) return null;
  return json.data.auth_code;
}

/**
 * TV 登录流程第②步：用已有 web 登录态静默自动确认 TV 二维码。
 * 复刻 biliup-rs credential.rs 的 web_confirm_qrcode。
 * @param {Function} fetchFn
 * @param {Object} webCookies 含 SESSDATA / bili_jct
 * @param {string} authCode
 * @returns {Promise<boolean>} 确认成功返回 true，否则 false
 */
async function tvWebConfirmQrcode(fetchFn, webCookies, authCode) {
  const resp = await fetchFn(`${PASSPORT}/x/passport-tv-login/h5/qrcode/confirm`, {
    method: 'POST',
    headers: {
      'User-Agent': TV_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `SESSDATA=${webCookies.SESSDATA}; bili_jct=${webCookies.bili_jct}`,
    },
    body: new URLSearchParams({
      auth_code: authCode,
      csrf: webCookies.bili_jct,
      scanning_type: '3',
    }).toString(),
  });
  const json = await resp.json();
  if (!json || json.code !== 0) return false;
  return true;
}

/**
 * TV 登录流程第③步：轮询换取 TV 端真正的 LoginInfo（含 token_info.access_token）。
 * 复刻 biliup-rs credential.rs 的 login_by_qrcode。最多轮询 15 次，间隔 1s。
 * @param {Function} fetchFn
 * @param {string} authCode
 * @param {Object} deps opts.deps（含可注入 sleep）
 * @returns {Promise<Object|null>} 成功返回 LoginInfo，失败返回 null
 */
async function tvLoginByQrcode(fetchFn, authCode, deps) {
  for (let i = 0; i < 15; i++) {
    const ts = String(Math.floor(Date.now() / 1000));
    const form = { appkey: TV_APPKEY, auth_code: authCode, local_id: '0', ts };
    const body = new URLSearchParams(form).toString();
    const sign3 = sign(body);
    const resp = await fetchFn(`${PASSPORT}/x/passport-tv-login/qrcode/poll`, {
      method: 'POST',
      headers: { 'User-Agent': TV_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({}, form, { sign: sign3 })).toString(),
    });
    const json = await resp.json();
    if (json && json.code === 0 && json.data) {
      const info = json.data; // biliup 的 LoginInfo（cookie_info + token_info + sso + platform）
      if (!info.platform) info.platform = 'BiliTV';
      if (!info.sso && info.cookie_info && info.cookie_info.cookies) {
        info.sso = info.cookie_info.cookies.map((c) => c.name + '=' + c.value);
      }
      return info;
    }
    if (json && json.code === 86039) { await sleep(1000, deps); continue; } // 尚未确认，继续轮询
    return null; // 其他错误码（含过期/失败），回落兜底
  }
  return null;
}

/**
 * 用 web 登录态换取 biliup 的 TV LoginInfo（含真正的 token_info.access_token）。
 * 复刻 biliup-rs 的 login_by_web_cookies：申请 TV 码 → web 静默确认 → 轮询拿 token。
 * 任何一步失败（网络/web cookie 过期/非 0 码/超时）返回 null（交由本地兜底拼装）。
 * @param {Object} webCookies 扁平 web cookie（含 SESSDATA/bili_jct）
 * @param {{deps?:Object}} [opts] opts.deps.fetchFn / opts.deps.sleep 可注入（单测）
 * @returns {Promise<Object|null>}
 */
async function exchangeLoginInfo(webCookies, opts = {}) {
  const deps = opts.deps || {};
  const fetchFn = deps.fetchFn || getFetch();
  // 空 web cookie 短路：无 SESSDATA/bili_jct 无法静默确认 TV 码，直接回落兜底（且不发请求）。
  if (!webCookies || !webCookies.SESSDATA || !webCookies.bili_jct) return null;
  try {
    const authCode = await tvGetQrcodeAuthCode(fetchFn, deps);
    if (!authCode) { logger.warn('[auth] TV token 换取失败：申请 auth_code 无结果'); return null; }
    const confirmed = await tvWebConfirmQrcode(fetchFn, webCookies, authCode);
    if (!confirmed) { logger.warn('[auth] TV token 换取失败：web 确认二维码未通过（SESSDATA/bili_jct 可能被风控）'); return null; }
    const info = await tvLoginByQrcode(fetchFn, authCode, deps);
    if (!info) { logger.warn('[auth] TV token 换取失败：login_by_qrcode 轮询无结果'); return null; }
    return info;
  } catch (e) {
    logger.warn('[auth] TV token 换取异常:', e && e.message ? e.message : e);
    return null;
  }
}

/**
 * 将 LoginInfo 写入 login_info.json（与扁平 web cookie 的 cookies.json 分离）。
 * @param {Object} loginInfo
 * @param {{path?:string}} [opts] opts.path 覆盖写入路径（单测用）
 * @returns {string} 写入的文件路径
 */
function saveLoginInfo(loginInfo, opts = {}) {
  const p = opts.path || store.getLoginInfoPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // AES-256-GCM 加密落盘；biliup.exe 上传前经 materializeLoginInfo 解密到临时文件使用
  fs.writeFileSync(p, JSON.stringify(secret.encryptObj(loginInfo)), 'utf8');
  logger.info('[auth] biliup LoginInfo 已写入', p);
  return p;
}

/**
 * 判断已有 LoginInfo 是否「新鲜可复用」——有效且未临近过期。
 * 复用优先级（根因A 修复）：用户扫码一次后，后续投稿直接复用持久化的有效 token，
 * 不再每次投稿都重换 TV 登录态。
 *
 * 判定：
 *   - 结构缺失（无 token_info / 无对象）→ 不可复用。
 *   - token_info.access_token 为空 → 不可复用（排除首次兜底拼装 / 换取失败的空 token，
 *     禁止让空 token 流到 biliup 造成迷惑性 code=-400）。
 *   - expires_in <= 0 → 视为长期有效（无法推算过期时间），允许复用（前提 access_token 非空）。
 *   - expires_in > 0 但 token_created_at 为 0/缺失 → 无法判定过期，保守视为临期，触发刷新/重换。
 *   - 正常情况：剩余有效期 = token_created_at + expires_in - now，剩余 > 安全缓冲即新鲜。
 *
 * @param {Object|null} loginInfo 现有 LoginInfo（或 null）
 * @param {{now?:number, safeBufferSeconds?:number}} [opts]
 *   - opts.now 覆盖当前时间戳（单测可注入固定值）
 *   - opts.safeBufferSeconds 覆盖安全缓冲秒数（默认 LOGIN_INFO_SAFE_BUFFER_SECONDS）
 * @returns {boolean}
 */
function isLoginInfoFresh(loginInfo, opts = {}) {
  if (!loginInfo || !loginInfo.token_info) return false;
  const ti = loginInfo.token_info;
  // 空 token 必须被排除（首次兜底拼装 / 换取失败），禁止复用。
  if (!ti.access_token) return false;
  const expiresIn = typeof ti.expires_in === 'number' ? ti.expires_in : 0;
  // expires_in<=0：视为长期有效（无法推算过期时间），允许复用（前提 access_token 非空）。
  if (expiresIn <= 0) return true;
  const createdAt = typeof ti.token_created_at === 'number' ? ti.token_created_at : 0;
  // token_created_at 缺失（0）→ 无法判定过期，保守视临期，触发刷新/重换。
  if (!createdAt) return false;
  const now = typeof opts.now === 'number' ? opts.now : Math.floor(Date.now() / 1000);
  const safeBuffer = typeof opts.safeBufferSeconds === 'number'
    ? opts.safeBufferSeconds
    : LOGIN_INFO_SAFE_BUFFER_SECONDS;
  const remaining = createdAt + expiresIn - now;
  return remaining > safeBuffer;
}

/**
 * 确保 login_info.json 存在且为最新：复用优先（根因A 修复）。
 *   1) 若已有 login_info.json 且 token 新鲜（isLoginInfoFresh）→ 直接返回该路径，
 *      不再发起任何 TV 请求（用户扫码一次后后续投稿直接复用持久化有效 token）。
 *   2) 否则走 TV 登录流程换取（拿真实 TV access_token），失败则本地用 web cookie 兜底拼装。
 * @param {Object} webCookies 扁平 web cookie（扫码所得）
 * @param {{path?:string, deps?:Object}} [opts]
 * @returns {Promise<string>} 写入的 login_info.json 路径
 */
async function ensureLoginInfo(webCookies, opts = {}) {
  // 根因A 修复：复用优先——已有未过期有效 token 直接复用，不再发起 TV 换取。
  const path0 = opts.path || store.getLoginInfoPath();
  const existing = loadLoginInfo(path0, opts);
  if (isLoginInfoFresh(existing)) {
    logger.info('[auth] 复用已持久化的有效登录态（未过期），跳过 TV 换取:', path0);
    return path0;
  }
  const exchanged = await exchangeLoginInfo(webCookies, opts);
  let loginInfo = exchanged || buildLoginInfoFromWebCookies(webCookies);
  // TV 换取成功但未带 token_created_at（部分环境 B站不返回该字段）：
  // 补写当前时间戳，便于下次复用推算过期，且不影响 biliup -u 兼容。
  if (loginInfo && loginInfo.token_info && loginInfo.token_info.access_token &&
      !loginInfo.token_info.token_created_at && loginInfo.token_info.expires_in > 0) {
    loginInfo.token_info.token_created_at = Math.floor(Date.now() / 1000);
  }
  return saveLoginInfo(loginInfo, opts);
}

/**
 * 刷新 TV access_token（用户要求「治本」解决反复出现的上传 -400 鉴权失败：
 * 根因是 TV 登录 token 过期）。
 * 端点：POST https://passport.bilibili.com/api/v2/oauth2/refresh_token
 *   （与 TV 登录同一套 appkey/secret 密钥体系，已权威确认，禁止臆造其他路径）
 * 刷新成功后顺带返回新 cookie（含新 SESSDATA），一并续上并写回磁盘。
 *
 * @param {Object} loginInfo 现有 LoginInfo（需含 token_info.access_token / token_info.refresh_token）
 * @param {{path?:string, deps?:Object}} [opts]
 *   - opts.path 写回路径（默认 store.getLoginInfoPath）；刷新成功后 saveLoginInfo 写盘到此
 *   - opts.deps.fetchFn 可注入（单测）；默认走 getFetch()
 * @returns {Promise<Object|null>}
 *   成功返回更新后的 loginInfo（已写盘新 token）；
 *   任一前置条件缺失（缺 access/refresh_token）/ 接口非 0 / 缺 token_info / 网络异常 → 返回 null
 */
async function refreshToken(loginInfo, opts = {}) {
  const deps = opts.deps || {};
  const fetchFn = deps.fetchFn || getFetch();

  const tokenInfo = (loginInfo && loginInfo.token_info) || {};
  const accessToken = tokenInfo.access_token;
  const refreshTokenVal = tokenInfo.refresh_token;
  // 任一缺失 → 无法刷新（如首次 web cookie 兜底拼装出来的空 token）
  if (!accessToken || !refreshTokenVal) return null;

  // 按 TV 签名规则拼请求体
  const form = {
    access_key: accessToken,
    appkey: TV_APPKEY,
    refresh_token: refreshTokenVal,
    ts: String(Math.floor(Date.now() / 1000)),
  };
  const sortedForm = Object.keys(form).sort().map((k) => k + '=' + form[k]).join('&');
  const sign1 = sign(sortedForm);
  const body = new URLSearchParams(Object.assign({}, form, { sign: sign1 })).toString();

  let json;
  try {
    const resp = await fetchFn('https://passport.bilibili.com/api/v2/oauth2/refresh_token', {
      method: 'POST',
      headers: { 'User-Agent': TV_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    json = await resp.json();
  } catch (e) {
    // 网络异常 → 刷新失败（失败安全，不向上抛）
    return null;
  }

  // 接口返回非 0 或缺少 token_info → 刷新失败（如 refresh_token 也失效）
  if (!json || json.code !== 0 || !json.data || !json.data.token_info) return null;

  const newTi = json.data.token_info;
  loginInfo.token_info.access_token = newTi.access_token;
  loginInfo.token_info.refresh_token = newTi.refresh_token;
  loginInfo.token_info.expires_in = newTi.expires_in || 0;
  loginInfo.token_info.token_created_at = Math.floor(Date.now() / 1000);

  // 刷新接口顺带返回新 cookie（含新 SESSDATA），一并续上。
  if (json.data.cookie_info && json.data.cookie_info.cookies) {
    loginInfo.cookie_info = json.data.cookie_info;
    loginInfo.sso = json.data.cookie_info.cookies.map((c) => c.name + '=' + c.value);
  }

  // 写回磁盘（与 biliup -u 指向同一文件，重试时 biliup 会读到新 token）
  saveLoginInfo(loginInfo, opts);
  return loginInfo;
}

/**
 * 上传前确保 token 新鲜（主动续期，治本 -400 鉴权失败，根因C 修复）。
 * 与 ensureLoginInfo 的区别：ensureLoginInfo 只「没有就换、有就复用」；
 * 本函数在「有但临期」时会在上传【前】主动刷新，而不是等上传 -400 后才事后重试。
 *
 * 流程：
 *   1) 读取已有 login_info.json；若已新鲜（isLoginInfoFresh）→ 直接复用，不刷新不重换。
 *   2) 若已存在但临期（剩余 < 安全缓冲）或 token_created_at 为 0/空（兜底空 token 或从未续期）
 *      → 先 refreshToken（需同时持有 access_token + refresh_token）；
 *        refresh 成功且刷新后新鲜 → 直接复用写回的新 token。
 *   3) 无可用登录态 / 刷新失败 → 用 web cookie 重新换取 TV token（兜底拼装）；
 *      若最终落盘的 token 仍为空 → 抛清晰错误「登录态失效,请重新扫码登录」，
 *      禁止静默把空 token 流到 biliup 造成迷惑性 code=-400（根因B 修复：失败明确化）。
 *
 * @param {Object} webCookies 扁平 web cookie（扫码所得）
 * @param {{path?:string, deps?:Object}} [opts] opts.deps.fetchFn / opts.deps.sleep 可注入（单测）
 * @returns {Promise<string>} 写入的 login_info.json 路径
 * @throws {Error} 最终拿不到有效 access_token 时抛清晰错误「登录态失效,请重新扫码登录」
 */
async function ensureFreshLoginInfo(webCookies, opts = {}) {
  const path0 = opts.path || store.getLoginInfoPath();
  const loginInfo = loadLoginInfo(path0, opts);

  // 情况1：已有可复用的有效 token → 直接复用（不刷新也不重换）。
  if (isLoginInfoFresh(loginInfo)) {
    logger.info('[auth] 检测到已持久化的有效登录态（未过期），直接复用:', path0);
    return path0;
  }

  // 情况2：已有登录态但临期（或从未续期/兜底空 token）→ 主动续期。
  if (loginInfo && loginInfo.token_info && loginInfo.token_info.access_token && loginInfo.token_info.refresh_token) {
    const refreshed = await refreshToken(loginInfo, Object.assign({}, opts, { path: path0 }));
    if (refreshed && isLoginInfoFresh(refreshed)) {
      logger.info('[auth] 上传前主动续期成功:', path0);
      return path0;
    }
  }

  // 情况3：无可用登录态 / 续期失败 → 用 web cookie 重新换取 TV token（兜底拼装）。
  await ensureLoginInfo(webCookies, Object.assign({}, opts, { path: path0 }));

  // 失败明确化（根因B）：最终落盘的 token 必须非空，否则直白抛错，禁止静默传空 token。
  const finalInfo = loadLoginInfo(path0, opts);
  if (!finalInfo || !finalInfo.token_info || !finalInfo.token_info.access_token) {
    // 先验证 web cookie 是否真的失效：仅 nav 明确返回「未登录」才要求重新扫码；
    // cookie 仍有效（或网络异常无法判定）时，换取失败只是网络/风控等瞬态，
    // biliup 空 token 也能用 web cookie 上传（实测可用），不误报「登录态失效」。
    const ck = await verifyCookies(webCookies, opts);
    const cookieProvenDead = ck && ck.ok === false && ck.code !== -1;
    if (!cookieProvenDead) {
      logger.warn('[auth] web cookie 仍有效但 TV token 换取失败（网络/风控），用 cookie 兜底继续:', path0);
      return path0;
    }
    throw new Error('登录态失效，请重新扫码登录（web cookie 也无法换取有效 token）');
  }
  return path0;
}

/**
 * 读取 login_info.json（供 task.js 在上传 -400 后重试刷新时读回当前 LoginInfo）。
 * @param {string} filePath login_info.json 完整路径（通常来自 store.getLoginInfoPath()）
 * @param {{fs?:Object}} [opts] opts.fs 覆盖文件系统实现（单测 mock）；默认真实 fs
 * @returns {Object|null} 解析成功返回对象；文件不存在 / 解析失败 → 返回 null（失败安全）
 */
function loadLoginInfo(filePath, opts = {}) {
  const f = opts.fs || fs;
  try {
    if (!filePath || !f.existsSync(filePath)) return null;
    const raw = f.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // 新版加密 blob → 解密；旧版明文 → 直接返回（兼容升级前遗留文件）
    return secret.isEncrypted(parsed) ? secret.decryptObj(parsed) : parsed;
  } catch (e) {
    return null;
  }
}

/**
 * 把 login_info.json 解密为临时明文文件，供 biliup.exe -u 读取（CLI 只认明文）。
 * 上传结束后调用方必须调用 cleanup() 删除临时文件，避免明文 token 残留。
 * @param {string} loginInfoPath login_info.json 完整路径
 * @param {{fs?:Object, tmpDir?:string}} [opts] opts.fs 可注入（单测 mock）
 * @returns {{path:string, cleanup:()=>void}}
 * @throws {Error} loginInfo 无法读取时抛出（调用方应中断上传）
 */
function materializeLoginInfo(loginInfoPath, opts = {}) {
  const f = opts.fs || fs;
  const info = loadLoginInfo(loginInfoPath, { fs: f });
  if (!info) {
    throw new Error('login_info.json 无法读取或不存在: ' + loginInfoPath);
  }
  const tmpPath = path.join(
    opts.tmpDir || os.tmpdir(),
    'biliup-logininfo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json'
  );
  f.writeFileSync(tmpPath, JSON.stringify(info), 'utf8');
  return {
    path: tmpPath,
    cleanup: () => {
      try { f.unlinkSync(tmpPath); } catch (_) { /* 已删除或不存在 */ }
    },
  };
}

/**
 * 清除登录态（退出登录）：best-effort 删除 credentials 文件。
 *
 * 仅删凭证，不动 config.json：
 *   - store.getCookiesPath()（扁平 web cookie，由二维码登录写入）
 *   - store.getLoginInfoPath()（biliup 上传用 LoginInfo，与 cookies.json 分离）
 * 任一文件不存在也不报错（fs.existsSync 判断后再 unlink）。
 *
 * @param {{fs?:Object}} [opts] opts.fs 覆盖文件系统实现（单测 mock）；默认用真实 fs。
 * @returns {{ok:boolean, cleared:string[]}} cleared 为实际删除的文件绝对路径列表。
 */
function clearSession(opts = {}) {
  const f = opts.fs || fs;
  const targets = [store.getCookiesPath(), store.getLoginInfoPath()];
  const cleared = [];
  for (const p of targets) {
    try {
      if (p && f.existsSync(p)) {
        f.unlinkSync(p);
        cleared.push(p);
      }
    } catch (e) {
      logger.warn('[auth] 删除凭证失败(' + p + '):', e.message);
    }
  }
  return { ok: true, cleared };
}

module.exports = {
  generateQrcode,
  pollQrcode,
  saveCookies,
  verifyCookies,
  parseSetCookie,
  buildLoginInfoFromWebCookies,
  exchangeLoginInfo,
  saveLoginInfo,
  verifyCookies,
  ensureLoginInfo,
  ensureFreshLoginInfo,
  isLoginInfoFresh,
  refreshToken,
  loadLoginInfo,
  materializeLoginInfo,
  clearSession,
  LOGIN_INFO_SAFE_BUFFER_SECONDS,
  // TV 登录流程相关（复刻 biliup-rs credential.rs）：供单测与上层复用
  sign,
  tvGetQrcodeAuthCode,
  tvWebConfirmQrcode,
  tvLoginByQrcode,
  TV_APPKEY,
  TV_APPSEC,
  TV_UA,
  PASSPORT,
};
