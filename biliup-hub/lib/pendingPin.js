// lib/pendingPin.js —— 定时发布「评论待置顶」队列
// 实测：定时待发布稿发评论可用（reply/add code=0），但置顶（reply/top）在发布/索引前不可靠（-404），
// 且评论区不可见无法确认是否生效。故置顶失败时落盘待置顶任务，由后台轮询等稿件发布后自动补置顶。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');
const cookiesLib = require('./cookies');
const comment = require('./comment');

const FILE = path.join(store.DATA_DIR, 'pending_pins.json');
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1';

function load(opts = {}) {
  const f = opts.file || FILE;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function save(list, opts = {}) {
  const f = opts.file || FILE;
  fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
}

function add(job, opts = {}) {
  const list = load(opts);
  const idx = list.findIndex((x) => Number(x.aid) === Number(job.aid));
  if (idx >= 0) {
    list[idx] = Object.assign({}, list[idx], job, { createdAt: list[idx].createdAt || Date.now() });
  } else {
    list.push(Object.assign({ createdAt: Date.now(), attempts: 0 }, job));
  }
  save(list, opts);
}

function remove(aid, opts = {}) {
  const list = load(opts);
  const next = list.filter((x) => Number(x.aid) !== Number(aid));
  if (next.length !== list.length) save(next, opts);
}

function list(opts = {}) {
  return load(opts);
}

async function fetchView(bvid, deps) {
  const fetchFn = deps.fetchFn || ((url, o) => fetch(url, o));
  const resp = await fetchFn(VIEW_URL + '?bvid=' + encodeURIComponent(String(bvid)), {
    headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/' },
  });
  return resp.json();
}

/**
 * 轮询一轮：稿件已公开（view code=0）→ 置顶 → 移除任务；未公开/失败则保留待下轮。
 * @param {{file?:string, cookiesPath?:string, fetchFn?:Function, pin?:Function,
 *         maxAttempts?:number, maxAgeMs?:number, onDone?:Function}} [opts]
 * @returns {Promise<{processed:number, pending:number}>}
 */
async function processPending(opts = {}) {
  let jobs = load(opts);
  if (!jobs.length) return { processed: 0, pending: 0 };
  const cookiePath = opts.cookiesPath || store.getConfig().cookiesPath;
  let cf = null;
  try { cf = cookiesLib.load(cookiePath); } catch (_) { cf = null; }
  if (!cf || !cookiesLib.validate(cf)) {
    logger.warn('[pending-pin] 登录态缺失/失效，跳过本轮（登录后自动继续）');
    return { processed: 0, pending: jobs.length };
  }
  const cookieHeader = cookiesLib.toHeader(cf);
  const csrf = cf.bili_jct;
  const maxAttempts = opts.maxAttempts || 60;
  const maxAgeMs = opts.maxAgeMs || 7 * 24 * 60 * 60 * 1000;
  const pinFn = opts.pin || comment.pin;
  let processed = 0;
  const survivors = [];
  for (const job of jobs) {
    if ((job.attempts || 0) >= maxAttempts || (Date.now() - (job.createdAt || 0)) > maxAgeMs) {
      logger.warn('[pending-pin] 任务超限清理:', { aid: job.aid, attempts: job.attempts });
      continue;
    }
    let view;
    try {
      view = await fetchView(job.bvid, opts);
    } catch (e) {
      survivors.push(job);
      continue; // 网络问题，下轮再试
    }
    if (!view || view.code !== 0) {
      survivors.push(job); // 尚未公开，等待发布
      continue;
    }
    try {
      const r = await pinFn(job.aid, job.rpid, csrf, cookieHeader, { deps: opts });
      if (r && r.ok) {
        processed += 1;
        logger.info('[pending-pin] 已自动置顶:', { aid: job.aid, rpid: job.rpid });
        if (typeof opts.onDone === 'function') opts.onDone(job);
      } else {
        job.lastError = 'pin 未返回 ok';
        job.attempts = (job.attempts || 0) + 1;
        survivors.push(job);
      }
    } catch (e) {
      job.lastError = e.message;
      job.attempts = (job.attempts || 0) + 1;
      survivors.push(job);
    }
  }
  save(survivors, opts);
  return { processed, pending: survivors.length };
}

/** 启动后台轮询（服务启动时 + 每 intervalMs）。 */
function startPoller(opts = {}) {
  const intervalMs = opts.intervalMs || 3 * 60 * 1000;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    processPending(opts).catch(() => {}).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  if (opts.immediate !== false) setTimeout(tick, opts.firstDelayMs || 1000);
  return timer;
}

module.exports = { load, save, add, remove, list, processPending, startPoller, fetchView, FILE };
