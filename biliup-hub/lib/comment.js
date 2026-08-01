// lib/comment.js —— 评论发布 + 置顶（B站 reply API）
// 端点：
//   发布：POST https://api.bilibili.com/x/v2/reply/add    → 返回 rpid
//   置顶：POST https://api.bilibili.com/x/v2/reply/top   → action=1 置顶 / action=0 取消
const logger = require('./logger');

const REPLY_ADD_URL = 'https://api.bilibili.com/x/v2/reply/add';
const REPLY_TOP_URL = 'https://api.bilibili.com/x/v2/reply/top';
const REPLY_SETTOP_ACTION = 1; // 1=置顶, 0=取消置顶

let _fetch;
function getFetch() {
  if (_fetch) return _fetch;
  try { _fetch = require('undici').fetch; } catch (e) { _fetch = (globalThis.fetch || global.fetch); }
  return _fetch;
}

const DEFAULT_DEPS = {
  getFetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  logger,
};

/**
 * 发布评论。返回 rpid（评论 ID）。
 * @param {number} aid 稿件 aid
 * @param {string} msg 评论内容
 * @param {string} csrf bili_jct
 * @param {string} cookieHeader 完整 Cookie 头
 * @param {{deps?:Object}} [opts]
 * @returns {Promise<number>} rpid
 */
async function post(aid, msg, csrf, cookieHeader, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const fetchFn = deps.fetchFn || deps.getFetch();
  const body = new URLSearchParams();
  body.set('type', '1');            // 1 = 视频稿件
  body.set('oid', String(aid));
  body.set('message', String(msg || ''));
  body.set('csrf', String(csrf));

  const resp = await fetchFn(REPLY_ADD_URL, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1',
    },
    body: body.toString(),
  });
  const json = await resp.json();
  if (!json || json.code !== 0) {
    throw new Error('评论发布失败: code=' + (json && json.code) + ' msg=' + (json && json.message));
  }
  const rpid = json.data && json.data.rpid;
  if (!rpid) {
    throw new Error('评论发布未返回 rpid: ' + JSON.stringify(json.data || json));
  }
  logger.info('[comment] 评论发布成功 rpid=', rpid);
  return rpid;
}

/**
 * 置顶评论。
 * @param {number} aid
 * @param {number} rpid
 * @param {string} csrf
 * @param {string} cookieHeader
 * @param {{deps?:Object}} [opts]
 * @returns {Promise<{ok:boolean, raw:Object}>}
 */
async function pin(aid, rpid, csrf, cookieHeader, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const fetchFn = deps.fetchFn || deps.getFetch();
  const body = new URLSearchParams();
  body.set('type', '1');            // 1 = 视频稿件
  body.set('oid', String(aid));
  body.set('rpid', String(rpid));
  body.set('action', String(REPLY_SETTOP_ACTION));
  body.set('csrf', String(csrf));

  const resp = await fetchFn(REPLY_TOP_URL, {
    method: 'POST',
    headers: {
      'Cookie': cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1',
    },
    body: body.toString(),
  });
  const json = await resp.json();
  if (!json || json.code !== 0) {
    const code = json && json.code;
    const msg = (json && json.message) || '';
    // -404（msg 多为「啥都木有」）：评论/稿件资源不存在。刚发布即被风控秒删或进入审核时常见，
    // 属 B站侧外部限制；本步骤本就非致命，且重试无法让已删评论复活，故不重试。
    if (code === -404) {
      throw new Error('评论置顶失败: code=-404（评论/稿件资源不存在，很可能刚发布即被风控删除或进入审核，属外部限制） msg=' + msg);
    }
    throw new Error('评论置顶失败: code=' + code + ' msg=' + msg);
  }
  logger.info('[comment] 评论置顶成功 rpid=', rpid);
  return { ok: true, raw: json };
}

module.exports = { post, pin, REPLY_ADD_URL, REPLY_TOP_URL, REPLY_SETTOP_ACTION, DEFAULT_DEPS };
