// lib/season.js —— 合集后置 API 调用（坑点2：season_id 被投稿接口忽略 → 独立 API 后置）
// 端点：POST https://member.bilibili.com/x2/creative/web/season/section/episodes/add
// 参数（官方 JSON 格式，已用真实账号实测通过）：URL 带 ?t=<unix秒>&csrf=<bili_jct>，
// 请求体 JSON：{ sectionId, episodes:[{aid,cid,title}], csrf } + 完整 Cookie。
// 注意：旧版 form-urlencoded（sectionId=...&episodes=JSON 字符串）实测返回 -400，勿改回。
// 坑点4：索引延迟返回 -404 → 重试 ≤20 次、间隔 10s。
const logger = require('./logger');

const SEASON_ADD_URL = 'https://member.bilibili.com/x2/creative/web/season/section/episodes/add';
const SEASONS_LIST_URL = 'https://member.bilibili.com/x2/creative/web/seasons';

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

  const url = SEASON_ADD_URL
    + '?t=' + Math.floor(Date.now() / 1000)
    + '&csrf=' + encodeURIComponent(String(csrf));
  const body = JSON.stringify({
    sectionId: Number(sectionId),
    episodes: [{ aid: Number(aid), cid: Number(cid), title: String(title || '') }],
    csrf: String(csrf),
  });

  let lastErr = null;
  for (let i = 1; i <= MAX; i++) {
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Cookie': cookieHeader,
          'Content-Type': 'application/json',
          'Referer': 'https://member.bilibili.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1',
        },
        body,
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

/**
 * 按合集解析「首个分集 ID」：用于存量配置只有 seasonId、没有 sectionId 时上传兜底。
 * 分集来源与 server.js /api/seasons 同源：优先顶层 sections.sections（嵌套，B站真实结构），
 * 回退 season.sections；两处都取不到返回 null（由调用方决定跳过合集后置，非致命）。
 * @param {string|number} seasonId 合集 ID
 * @param {string} cookieHeader 完整 Cookie 头（含 SESSDATA）
 * @param {{deps?:Object}} [opts]
 * @returns {Promise<string|null>}
 */
async function resolveFirstSectionId(seasonId, cookieHeader, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const fetchFn = deps.fetchFn || deps.getFetch();
  const url = SEASONS_LIST_URL
    + '?pn=1&ps=50&t=' + Math.floor(Date.now() / 1000);
  let resp;
  try {
    resp = await fetchFn(url, {
      headers: {
        'Cookie': cookieHeader,
        'Referer': 'https://member.bilibili.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1',
      },
    });
  } catch (e) {
    logger.warn('[season] 解析首个分集失败（网络）:', e.message);
    return null;
  }
  if (resp && resp.ok === false) return null;
  let json;
  try { json = await resp.json(); } catch (e) { return null; }
  if (!json || json.code !== 0) return null;
  const seasons = Array.isArray(json.data && json.data.seasons) ? json.data.seasons : [];
  const s = seasons.find((x) => x && x.season && String(x.season.id) === String(seasonId));
  if (!s) return null;
  const nested = s.sections && Array.isArray(s.sections.sections) ? s.sections.sections : [];
  const seasonSecs = Array.isArray(s.season.sections) ? s.season.sections : [];
  const secs = nested.length > 0 ? nested : seasonSecs;
  const first = secs.find((sec) => sec && sec.id != null);
  return first ? String(first.id) : null;
}

module.exports = { add, resolveFirstSectionId, SEASON_ADD_URL, SEASONS_LIST_URL, DEFAULT_DEPS };
