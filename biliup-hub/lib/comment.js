// lib/comment.js —— 评论发布 + 置顶（B站 reply API）
// 端点（社区已知形态，待实测确认，见设计 §8.3）：
//   发布：POST https://api.bilibili.com/x/v2/reply/add   → 返回 rpid
//   置顶：POST https://api.bilibili.com/x/v2/reply/action → action=3 置顶
const logger = require('./logger');

// TODO(实测): 以下端点 / action 码以社区已知形态为准，v1 回归时请实测确认。
const REPLY_ADD_URL = 'https://api.bilibili.com/x/v2/reply/add';
const REPLY_ACTION_URL = 'https://api.bilibili.com/x/v2/reply/action';
const REPLY_TOP_ACTION = 3; // TODO(实测): 置顶 action 码；社区已知为 3

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
  body.set('type', '1');
  body.set('oid', String(aid));
  body.set('rpid', String(rpid));
  body.set('action', String(REPLY_TOP_ACTION));
  body.set('csrf', String(csrf));

  const resp = await fetchFn(REPLY_ACTION_URL, {
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
    throw new Error('评论置顶失败: code=' + (json && json.code) + ' msg=' + (json && json.message));
  }
  logger.info('[comment] 评论置顶成功 rpid=', rpid);
  return { ok: true, raw: json };
}

module.exports = { post, pin, REPLY_ADD_URL, REPLY_ACTION_URL, REPLY_TOP_ACTION, DEFAULT_DEPS };
