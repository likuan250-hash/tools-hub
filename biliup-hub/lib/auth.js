// lib/auth.js —— B站扫码登录（#7，自实现，不依赖 biliup.exe 终端输出）
//
// 说明（偏离说明，见报告）：biliup-rs 的 `login` 子命令会把二维码往终端打 ASCII，
// 无法干净地传给浏览器渲染；且其登录态最终也落在本工具的 cookies.json。
// 故这里直接调用 B站官方扫码登录 API（与 biliup 底层同一套机制）：
//   1) generate 取 qrcode_key + 二维码内容 url
//   2) 后端用 qrcode 库把 url 渲染成 PNG dataURL 交给前端 <img> 展示
//   3) poll 轮询状态；成功后从 Set-Cookie 取出 SESSDATA/bili_jct 等写入 BILIUP_DATA_DIR/cookies.json
// cookie 最终落到与投稿上传同一份文件（--cookies 指向它），格式为 cookies.load 支持的对象形态。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');

const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1';
const REFERER = 'https://passport.bilibili.com/';

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
 * 将登录得到的 cookies 写入 BILIUP_DATA_DIR/cookies.json（与投稿上传同一份）。
 * @param {Object} cookiesObj
 * @param {{path?:string}} [opts] opts.path 覆盖写入路径（单测用）
 */
function saveCookies(cookiesObj, opts = {}) {
  const p = opts.path || store.getCookiesPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cookiesObj, null, 2), 'utf8');
  logger.info('[auth] 登录 cookie 已写入', p);
  return p;
}

module.exports = { generateQrcode, pollQrcode, saveCookies, parseSetCookie };
