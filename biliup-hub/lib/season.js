// lib/season.js —— 合集后置 API 调用（坑点2：season_id 被投稿接口忽略 → 独立 API 后置）
// 端点：POST https://member.bilibili.com/x2/creative/web/season/section/episodes/add
// 参数：sectionId=7630305（非 season_id）、episodes=[{aid,cid,title,charging_pay:0}]、csrf=bili_jct + 完整 Cookie。
// 坑点4：索引延迟返回 -404 → 重试 ≤20 次、间隔 10s。
const logger = require('./logger');

// TODO(实测): 以下端点与字段以社区已知形态为准，v1.2.1 回归时请实测确认。
const SEASON_ADD_URL = 'https://member.bilibili.com/x2/creative/web/season/section/episodes/add';

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
 * 后置添加稿件到合集。
 * @param {string|number} sectionId 合集分集 ID（注意：非 season_id，见设计 §1.3）
 * @param {number} aid
 * @param {number} cid
 * @param {string} title
 * @param {string} csrf bili_jct
 * @param {string} cookieHeader 完整 Cookie 头（含 SESSDATA）
 * @param {{onLog?:Function, deps?:Object}} [opts]
 * @returns {Promise<{ok:boolean, raw:Object}>}
 */
async function add(sectionId, aid, cid, title, csrf, cookieHeader, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const fetchFn = deps.fetchFn || deps.getFetch();
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const MAX = 20;
  const INTERVAL = 10000;

  const episodes = [{ aid: Number(aid), cid: Number(cid), title: String(title || ''), charging_pay: 0 }];
  const body = new URLSearchParams();
  body.set('sectionId', String(sectionId));
  body.set('csrf', String(csrf));
  body.set('episodes', JSON.stringify(episodes));

  let lastErr = null;
  for (let i = 1; i <= MAX; i++) {
    try {
      const resp = await fetchFn(SEASON_ADD_URL, {
        method: 'POST',
        headers: {
          'Cookie': cookieHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://member.bilibili.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1',
        },
        body: body.toString(),
      });
      const json = await resp.json();
      if (json && json.code === 0) {
        logger.info('[season] 合集后置成功:', { sectionId, aid });
        return { ok: true, raw: json };
      }
      if (json && json.code === -404) {
        // 索引延迟：等待重试
        lastErr = new Error('合集接口 -404（稿件可能尚未索引）');
        onLog('合集后置重试 ' + i + '/' + MAX + ' (-404) ...');
        if (i < MAX) await deps.sleep(INTERVAL);
        continue;
      }
      // 其他非 0 码：立即失败（如 csrf 缺失 / 权限不足）
      throw new Error('合集添加失败: code=' + (json && json.code) + ' msg=' + (json && json.message));
    } catch (e) {
      // 传输错误视为可重试（网络抖动 / 索引延迟）
      if (i < MAX && /-404|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|socket/i.test(String(e.message))) {
        lastErr = e;
        onLog('合集后置重试 ' + i + '/' + MAX + ' (' + e.message + ') ...');
        await deps.sleep(INTERVAL);
        continue;
      }
      lastErr = e;
      break;
    }
  }
  throw new Error('合集后置失败，重试耗尽(20/10s): ' + (lastErr && lastErr.message));
}

module.exports = { add, SEASON_ADD_URL, DEFAULT_DEPS };
