// lib/comment.js —— 评论发布 + 置顶（B站 reply API）
// 端点：
//   发布：POST https://api.bilibili.com/x/v2/reply/add    → 返回 rpid
//   置顶：POST https://api.bilibili.com/x/v2/reply/top   → action=1 置顶 / action=0 取消
const logger = require('./logger');

const REPLY_ADD_URL = 'https://api.bilibili.com/x/v2/reply/add';
const REPLY_TOP_URL = 'https://api.bilibili.com/x/v2/reply/top';
const REPLY_SETTOP_ACTION = 1; // 1=置顶, 0=取消置顶

// 投稿刚完成时稿件处于审核/索引期，评论接口会短暂返回 -404（评论主题未就绪）。
// 对 -404 做有上限重试，其余错误码直接失败。默认 10 次 × 3s 指数退避（上限 30s），
// 总时长约 1 分钟内——覆盖「刚投稿即评论」的典型延迟窗口。
const RETRY_MAX = 10;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 30000;

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
 * 对返回 -404 的请求做有上限重试（稿件审核期评论主题未就绪的典型错误码）。
 * @param {() => Promise<object>} run 执行一次请求，返回 B站 JSON 响应
 * @param {{deps?:Object, retryMax?:number, retryBaseMs?:number, retryMaxMs?:number}} [opts]
 * @returns {Promise<object>} 首次非 -404 的响应；重试耗尽后抛出带重试次数的错误
 */
async function withRetryOn404(run, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const sleep = deps.sleep || DEFAULT_DEPS.sleep;
  const max = Number.isFinite(opts.retryMax) ? opts.retryMax : RETRY_MAX;
  const baseMs = Number.isFinite(opts.retryBaseMs) ? opts.retryBaseMs : RETRY_BASE_MS;
  const capMs = Number.isFinite(opts.retryMaxMs) ? opts.retryMaxMs : RETRY_MAX_MS;
  let lastJson = null;
  for (let i = 1; i <= max; i++) {
    // eslint-disable-next-line no-await-in-loop
    const json = await run();
    lastJson = json;
    if (json && json.code !== -404) return json;
    if (i < max) {
      const wait = Math.min(capMs, Math.round(baseMs * Math.pow(1.4, i - 1)));
      // eslint-disable-next-line no-await-in-loop
      await sleep(wait);
    }
  }
  const code = lastJson && lastJson.code;
  const msg = (lastJson && lastJson.message) || '';
  const err = new Error('评论接口持续 -404（稿件审核中/资源未就绪），重试 ' + max + ' 次仍失败: code=' + code + ' msg=' + msg);
  err.retried = max;
  throw err;
}

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

  const json = await withRetryOn404(async () => {
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
    return resp.json();
  }, { deps });
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

  const json = await withRetryOn404(async () => {
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
    return resp.json();
  }, { deps });
  if (!json || json.code !== 0) {
    const code = json && json.code;
    const msg = (json && json.message) || '';
    throw new Error('评论置顶失败: code=' + code + ' msg=' + msg);
  }
  logger.info('[comment] 评论置顶成功 rpid=', rpid);
  return { ok: true, raw: json };
}

module.exports = { post, pin, withRetryOn404, REPLY_ADD_URL, REPLY_TOP_URL, REPLY_SETTOP_ACTION, DEFAULT_DEPS, RETRY_MAX, RETRY_BASE_MS, RETRY_MAX_MS };
