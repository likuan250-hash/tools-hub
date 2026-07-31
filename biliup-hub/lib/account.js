// lib/account.js —— 查询 B站登录态（#7 显示头像/昵称）
// GET /api/account 后端：读 cookies → 调 nav 接口 → 返回 { uname, face, mid, isLogin }
// 带 5 分钟内存缓存；失败/未登录统一返回 { isLogin:false }，不抛异常。
const cookies = require('./cookies');
const store = require('./store');
const logger = require('./logger');

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1';
const TTL = 5 * 60 * 1000; // 5 分钟

let _fetch;
function getFetch() {
  if (_fetch) return _fetch;
  try { _fetch = require('undici').fetch; } catch (e) { _fetch = (globalThis.fetch || global.fetch); }
  return _fetch;
}

let cache = { ts: 0, data: { isLogin: false } };

/**
 * 实际查询账号信息（可注入 fetchFn 便于单测）。
 * @param {{cookiesPath?:string, deps?:Object}} [opts]
 *   opts.cookiesPath 覆盖 cookie 路径（单测用）；opts.deps.fetchFn 注入 fetch。
 * @returns {Promise<{isLogin:boolean, uname?:string, face?:string, mid?:number}>}
 */
async function fetchAccount(opts = {}) {
  const deps = opts.deps || {};
  const fetchFn = deps.fetchFn || getFetch();
  const cfg = store.getConfig();
  const cookiesPath = opts.cookiesPath || cfg.cookiesPath;

  let cf = null;
  try { cf = cookies.load(cookiesPath); } catch (e) { /* 下面校验 */ }
  if (!cf || !cookies.validate(cf)) {
    return { isLogin: false };
  }

  const cookieHeader = cookies.toHeader(cf);
  try {
    const resp = await fetchFn(NAV_URL, {
      headers: {
        'Cookie': cookieHeader,
        'Referer': 'https://www.bilibili.com/',
        'User-Agent': USER_AGENT,
      },
    });
    const json = await resp.json();
    if (json && json.code === 0 && json.data && json.data.isLogin) {
      return {
        isLogin: true,
        uname: json.data.uname,
        face: json.data.face,
        mid: json.data.mid,
      };
    }
    return { isLogin: false };
  } catch (e) {
    logger.warn('[account] nav 请求失败:', e.message);
    return { isLogin: false };
  }
}

/**
 * 带缓存的对外查询入口。
 * @param {Object} [opts] 透传给 fetchAccount
 * @returns {Promise<Object>}
 */
async function getAccount(opts) {
  const now = Date.now();
  if (now - cache.ts < TTL) return cache.data;
  const result = await fetchAccount(opts);
  cache = { ts: now, data: result };
  return result;
}

/** 主动失效缓存（登录成功/过期后调用，立即反映最新态）。 */
function invalidate() {
  cache = { ts: 0, data: { isLogin: false } };
}

module.exports = { getAccount, fetchAccount, invalidate, NAV_URL, TTL };
