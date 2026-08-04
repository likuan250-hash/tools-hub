// lib/cover.js —— ffmpeg 抽帧（抽视频第 1 秒作为封面）
// 探测优先级：UI 配置的 ffmpegPath → biliup 同目录 ffmpeg(.exe) → PATH 的 ffmpeg。
// 失败仅告警，不阻断投稿流程（封面缺失时 biliup 会用默认封面）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const logger = require('./logger');

/**
 * 解析可用的 ffmpeg 可执行路径。
 * @param {Object} opts { ffmpegPath?, biliupExePath? }
 * @returns {string|null} ffmpeg 路径（找不到返回 null）
 */
function resolveFfmpeg(opts = {}) {
  const candidates = [];
  if (opts.ffmpegPath) candidates.push(opts.ffmpegPath);
  // biliup 同目录探测
  if (opts.biliupExePath) {
    const dir = path.dirname(opts.biliupExePath);
    candidates.push(path.join(dir, 'ffmpeg.exe'));
    candidates.push(path.join(dir, 'ffmpeg'));
  }
  // PATH 探测
  candidates.push('ffmpeg');
  for (const c of candidates) {
    try {
      // 绝对/相对路径存在即视为可用；'ffmpeg' 走 PATH 由 execFile 解析
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

/**
 * 抽第 1 秒帧作为封面。
 * @param {string} videoPath
 * @param {string|null} ffmpegPath 已解析的 ffmpeg 路径（可为 null → 内部再探测）
 * @param {{onLog?:Function, deps?:Object}} [opts]
 * @returns {Promise<string|null>} 成功返回封面 png 路径；失败返回 null（仅告警）
 */
async function extract(videoPath, ffmpegPath, opts = {}) {
  const deps = Object.assign({ execFile }, opts.deps || {});
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const ff = ffmpegPath || resolveFfmpeg(opts);
  if (!ff) {
    logger.warn('[cover] 未找到 ffmpeg，跳过抽帧（biliup 将使用默认封面）');
    onLog('未找到 ffmpeg，跳过抽帧');
    return null;
  }
  if (!videoPath || !fs.existsSync(videoPath)) {
    logger.warn('[cover] 视频文件不存在，跳过抽帧:', videoPath);
    onLog('视频文件不存在，跳过抽帧');
    return null;
  }

  const outPath = path.join(os.tmpdir(), 'biliup-cover-' + Date.now() + '.png');
  const args = [
    '-y',
    '-ss', '00:00:01',
    '-i', videoPath,
    '-vframes', '1',
    '-q:v', '2',
    outPath,
  ];

  return new Promise((resolve) => {
    const child = deps.execFile(ff, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err) => {
      if (err) {
        logger.warn('[cover] 抽帧失败（仅告警，不阻断）:', err.message);
        onLog('抽帧失败: ' + err.message);
        resolve(null);
        return;
      }
      try {
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          logger.info('[cover] 抽帧成功:', outPath);
          onLog('抽封面帧1 ... ok');
          resolve(outPath);
        } else {
          logger.warn('[cover] 抽帧输出为空，跳过封面');
          onLog('抽帧输出为空，跳过封面');
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      }
    });
    if (child.stdout) child.stdout.on('data', () => {});
  });
}

module.exports = { extract, resolveFfmpeg };
