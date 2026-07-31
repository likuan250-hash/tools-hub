// lib/biliup.js —— 执行上传（临时脚本）+ getVideoInfo 重试（坑点4：-404 延迟索引）
const command = require('./command');
const logger = require('./logger');

// Node 18+ 自带 fetch（undici）。优先用全局 fetch；若需强约束可用 undici.fetch（可选依赖）。
let _fetch;
function getFetch() {
  if (_fetch) return _fetch;
  try {
    _fetch = require('undici').fetch; // 可选依赖，缺失时回退全局
  } catch (e) {
    _fetch = (globalThis.fetch || global.fetch);
  }
  return _fetch;
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) biliup-hub/0.1';

// 默认依赖（真实实现）；测试经 opts.deps 注入 mock。
const DEFAULT_DEPS = {
  runViaTempScript: command.runViaTempScript,
  getFetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  logger,
};

// ── 从 biliup stdout 解析投稿结果（bvid + aid）──
// biliup-rs 上传成功会输出 BV 号与 aid（JSON 或日志行）。多策略兜底解析。
function parseUploadOutput(stdout) {
  const text = String(stdout || '');
  // 优先匹配 JSON 形态：{"bvid":"BV...","aid":123} 或 "aid":123,"bvid":"BV..."
  const bvidMatch = text.match(/BV[0-9A-Za-z]+/);
  const bvid = bvidMatch ? bvidMatch[0] : null;
  let aid = null;
  const aidJson = text.match(/"(?:aid|AVID)"\s*:\s*(\d+)/i);
  if (aidJson) aid = Number(aidJson[1]);
  else {
    const aidPlain = text.match(/aid[=:\s]+(\d+)/i);
    if (aidPlain) aid = Number(aidPlain[1]);
  }
  return { bvid, aid };
}

/**
 * 执行上传（跑临时脚本，转发 child_process 输出）。
 * @param {{content:string, shell:string}} scriptFile
 * @param {{onLog?:Function, deps?:Object}} [opts]
 * @returns {Promise<{bvid:string|null, aid:number|null}>}
 */
async function runUpload(scriptFile, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const { stdout } = await deps.runViaTempScript(scriptFile, { onLog, deps: opts.deps });
  const ref = parseUploadOutput(stdout);
  if (!ref.bvid && !ref.aid) {
    // 解析失败：仍返回（上层可用 getVideoInfo 按 bvid 兜底），但记录告警。
    logger.warn('[biliup] 未能从输出解析 bvid/aid，原始输出:', stdout.slice(0, 500));
  }
  return ref;
}

/**
 * 取稿件信息（aid/cid/title）。
 * 坑点4：B站 API 可能延迟索引，返回 code=-404 → 重试 ≤20 次、间隔 10s。
 * @param {{bvid?:string, aid?:number}} ref
 * @param {{onLog?:Function, deps?:Object}} [opts]
 *   opts.deps.fetchFn 可注入（单测 mock）；opts.deps.sleep 可注入瞬时（单测）。
 * @returns {Promise<{aid:number, cid:number, title:string}>}
 */
async function getVideoInfo(ref, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const fetchFn = deps.fetchFn || deps.getFetch();
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const MAX = 20;
  const INTERVAL = 10000;
  const bvid = ref && ref.bvid;
  const aid = ref && ref.aid;
  if (!bvid && !aid) {
    throw new Error('getVideoInfo 缺少 bvid/aid，无法查询稿件信息');
  }
  let lastErr = null;
  for (let i = 1; i <= MAX; i++) {
    try {
      const url = bvid
        ? 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)
        : 'https://api.bilibili.com/x/web-interface/view?aid=' + encodeURIComponent(aid);
      const resp = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/' } });
      const json = await resp.json();
      if (json && json.code === 0 && json.data) {
        const data = json.data;
        const cid = (data.pages && data.pages[0] && data.pages[0].cid) || data.cid;
        return { aid: data.aid, cid: cid, title: data.title };
      }
      if (json && json.code === -404) {
        // 尚未索引，等待重试
        lastErr = new Error('稿件尚未索引 (code=-404)');
        onLog('getVideoInfo 重试 ' + i + '/' + MAX + ' (-404) ...');
        if (i < MAX) await deps.sleep(INTERVAL);
        continue;
      }
      // 其他非 0 码：立即失败（如 -101 未登录 / -404 之外的错误）
      throw new Error('getVideoInfo 返回 code=' + (json && json.code) + ' msg=' + (json && json.message));
    } catch (e) {
      // 仅传输/网络类错误可重试（索引延迟/网络抖动）；
      // 非 -404 的业务错误码已在 try 中 throw 并应在此立即失败（不重试）。
      const retryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|socket|fetch failed|timeout/i.test(String(e.message));
      lastErr = e;
      if (i < MAX && retryable) {
        onLog('getVideoInfo 重试 ' + i + '/' + MAX + ' (' + e.message + ') ...');
        await deps.sleep(INTERVAL);
        continue;
      }
      break;
    }
  }
  throw new Error('getVideoInfo 重试耗尽(20/10s)：' + (lastErr && lastErr.message));
}

module.exports = { runUpload, getVideoInfo, parseUploadOutput, DEFAULT_DEPS, USER_AGENT };
