// lib/biliup.js —— 执行上传（临时脚本）+ getVideoInfo 重试（坑点4：-404 延迟索引）
const fs = require('fs');
const path = require('path');
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
  fs, // 可注入（单测 mock，避免真实落盘）
};

// ── 从 biliup stdout 解析投稿结果（bvid + aid）──
// biliup-rs 上传成功会输出 BV 号与 aid（JSON 或日志行）。多策略兜底解析。
function parseUploadOutput(stdout) {
  const text = String(stdout || '');
  // 优先匹配 JSON 形态：{"bvid":"BV...","aid":123} 或 "aid":123,"bvid":"BV..."
  // biliup-rs 实际输出中 aid 在 ResponseData 里为 "aid": Number(117042187343755) 形态，
  // 支持 Number(...) 包裹，避免定时投稿 aid 解析成空。
  const bvidMatch = text.match(/BV[0-9A-Za-z]+/);
  const bvid = bvidMatch ? bvidMatch[0] : null;
  let aid = null;
  const aidJson = text.match(/"(?:aid|AVID)"\s*:\s*(?:Number\(\s*)?(\d+)/i);
  if (aidJson) aid = Number(aidJson[1]);
  else {
    const aidPlain = text.match(/aid[=:\s]+(\d+)/i);
    if (aidPlain) aid = Number(aidPlain[1]);
  }
  return { bvid, aid };
}

// 完整上传输出落盘目录（与 command 共用 .tmp）。
const UPLOAD_LOG_DIR = command.TMP_DIR;

/**
 * 将完整 stdout + stderr + exit code 落盘（根治铺路的关键证据）。
 * 无论解析成败都落盘，便于人工/根治核对「exit0 但无标识」的真实原因。
 * @param {string} stdout biliup 标准输出
 * @param {string} stderr biliup 标准错误
 * @param {number} code 进程退出码（0/非0/null）
 * @param {Object} [fsImpl] 文件系统实现（默认模块级 fs；单测可注入 mock）
 * @returns {string|null} 落盘文件路径；失败返回 null
 */
function writeUploadLog(stdout, stderr, code, fsImpl) {
  const f = fsImpl || fs;
  try {
    f.mkdirSync(UPLOAD_LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(UPLOAD_LOG_DIR, `upload-${ts}.log`);
    // utf-8 无 BOM；含时间戳、exit code 与完整 stdout/stderr。
    const header = `[${new Date().toISOString()}] biliup upload finished (exit=${code})\n`;
    const body = header +
      '----- stdout -----\n' + (stdout || '') +
      '\n----- stderr -----\n' + (stderr || '') + '\n';
    f.writeFileSync(logPath, body, { encoding: 'utf8' });
    return logPath;
  } catch (e) {
    logger.error('[biliup] 上传日志落盘失败:', e.message);
    return null;
  }
}

// B站 API 失败特征关键字（不区分大小写）：鉴权/会话失效类错误。
const BILIUP_API_FAILURE_KEYWORDS = /请求错误|未登录|登录失效|登录过期|请先登录|token|cookie|鉴权|UNAUTHORIZED|csrf/i;

/**
 * 检测 biliup 是否以「exit0 假成功」收场、但 stderr 暴露了 B站 API 失败（多为登录态失效/鉴权失败）。
 *
 * 真实场景（见上传日志）：biliup 退出码返回 0，但 stderr 打印
 *   Error: {"code":-400,"data":null,"message":"请求错误","ttl":1}
 * 这是登录态过期/鉴权的典型信号。若不及时暴露，下游 getVideoInfo 会因 ref 为空抛出
 * 误导性的「getVideoInfo 缺少 bvid/aid」错误，掩盖真实原因。
 *
 * 行为：
 *  - 命中失败时【直接抛出】清晰错误（让 task 早报真实失败原因，而非 getVideoInfo 当替罪羊）。
 *  - stderr 完全为空（真·静默成功但无标识）→ 不抛，交由调用方维持 WARN + 返回空 ref 的旧行为。
 *
 * @param {string} stderr biliup 标准错误输出
 */
function detectBiliupApiFailure(stderr) {
  const text = String(stderr || '');
  if (!text.trim()) return; // 空 stderr：真·静默成功但无标识，不抛（保留旧行为，避免误杀）
  // 优先：解析 JSON 形态错误 {"code":<负数>,"message":"<msg>"}（字段顺序可能含 data 等中间键）。
  const codeMatch = text.match(/"code"\s*:\s*(-?\d+)/);
  if (codeMatch && parseInt(codeMatch[1], 10) < 0) {
    const msgMatch = text.match(/"message"\s*:\s*"([^"]*)"/);
    const message = msgMatch ? msgMatch[1] : '未知错误';
    throw new Error('biliup 上传失败(code=' + codeMatch[1] + '): ' + message);
  }
  // 退化：关键字命中（鉴权/会话相关）。
  if (BILIUP_API_FAILURE_KEYWORDS.test(text)) {
    throw new Error('biliup 上传失败(疑似鉴权/会话失效): ' + text.slice(0, 200));
  }
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
  const { stdout, stderr, code } = await deps.runViaTempScript(scriptFile, { onLog, deps: opts.deps });

  // ② 完整 stdout/stderr/exit code 落盘（无论解析成败都落盘，根治铺路关键证据）。
  const fsImpl = deps.fs || fs;
  const logPath = writeUploadLog(stdout, stderr, code, fsImpl);

  const ref = parseUploadOutput(stdout);
  if (!ref.bvid && !ref.aid) {
    // ① 上传真实性早报：
    if (code != null && code !== 0) {
      // exit!=0 → 明确抛「上传失败」，让 task 早报真实失败，而非下游 getVideoInfo 当替罪羊。
      throw new Error('biliup 上传失败(exit=' + code + '): ' + (stderr || '').slice(0, 300));
    }
    // exit==0 或 code 为 null：检测 stderr 是否暗示 B站 API 失败（exit0 假成功）。
    // 命中（如 {"code":-400,"message":"请求错误"} 或鉴权/会话失效关键字）即【抛出清晰错误】，
    // 让 task 早报真实失败原因，而非下游 getVideoInfo 当替罪羊报误导性「缺少 bvid/aid」。
    detectBiliupApiFailure(stderr); // 命中则抛错（不返回）
    // 未命中（stderr 为空或无失败特征）→ 维持现状 WARN + 返回空 ref（保留旧行为，避免误杀）。
    logger.warn('[biliup] 上传已结束(exit=0)但未从输出解析到 bvid/aid，完整日志已落盘: ' + logPath);
  }
  return ref;
}

/**
 * 取稿件信息（aid/cid/title）。
 * 坑点4：B站 API 可能延迟索引，返回 code=-404 → 采用指数退避重试，最多 120 次。
 *   起始间隔 5s，每轮 ×1.4，封顶 30s（最坏约 60 分钟，覆盖绝大多数转码+审核延迟）。
 * @param {{bvid?:string, aid?:number}} ref
 * @param {{onLog?:Function, deps?:Object}} [opts]
 *   opts.deps.fetchFn 可注入（单测 mock）；opts.deps.sleep 可注入瞬时（单测）。
 * @returns {Promise<{aid:number, cid:number, title:string}>}
 */
async function getVideoInfo(ref, opts = {}) {
  const deps = Object.assign({}, DEFAULT_DEPS, opts.deps || {});
  const fetchFn = deps.fetchFn || deps.getFetch();
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const MAX = 120;
  const BASE_INTERVAL = 5000;
  const FACTOR = 1.4;
  const MAX_INTERVAL = 30000;
  const bvid = ref && ref.bvid;
  const aid = ref && ref.aid;
  if (!bvid && !aid) {
    throw new Error('getVideoInfo 缺少 bvid/aid，无法查询稿件信息');
  }
  let lastErr = null;
  for (let i = 1; i <= MAX; i++) {
    const wait = Math.min(MAX_INTERVAL, Math.round(BASE_INTERVAL * Math.pow(FACTOR, i - 1)));
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
        if (i < MAX) await deps.sleep(wait);
        continue;
      }
      // 定时发布：稿件已过审但未到发布时间，公开接口查不到；不是 -404 索引延迟，
      // 直接报「定时发布待发布」，不再空转重试。
      if (json && json.code === 62003) {
        const err = new Error('稿件已通过审核，等待定时发布 (code=62003)');
        err.code = 62003;
        err.scheduled = true;
        throw err;
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
        await deps.sleep(wait);
        continue;
      }
      break;
    }
  }
  const finalErr = new Error('getVideoInfo 重试耗尽(' + MAX + '/指数退避 5s→30s)：' + (lastErr && lastErr.message));
  // 保留业务错误特征（如 62003 定时发布待发布），供调用方区分「定时」与「真失败」。
  if (lastErr && lastErr.code) finalErr.code = lastErr.code;
  if (lastErr && lastErr.scheduled) finalErr.scheduled = true;
  throw finalErr;
}

module.exports = { runUpload, getVideoInfo, parseUploadOutput, writeUploadLog, detectBiliupApiFailure, DEFAULT_DEPS, USER_AGENT };
