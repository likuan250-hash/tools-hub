// lib/env.js —— 外部 CLI 环境检测（yt-dlp / ffmpeg 是否在 PATH）
// 设计约定：不引 yt-dlp / ffmpeg 的 npm 包，只探测系统 PATH 中的二进制；
// 缺失时给出清晰安装引导文案，由上层决定「仅该项报错、不崩溃、不阻塞封面下载」。
const { spawnSync } = require('child_process');

// 安装引导文案（与设计 §3.2 error 事件 detail.guidance 对齐）
const YT_DLP_GUIDANCE = 'pip install yt-dlp  或  https://github.com/yt-dlp/yt-dlp#installation';
const FFMPEG_GUIDANCE = 'winget install Gyan.FFmpeg  或  https://ffmpeg.org/download.html';

/**
 * 默认的 PATH 探测实现：Windows 用 `where`，其余平台用 `which`。
 * 单测经构造函数注入替身，绝不真实 spawn。
 * @param {string} cmd 待探测的命令名，如 'yt-dlp'
 * @returns {boolean} 命令是否存在于 PATH
 */
function defaultSpawnWhich(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(probe, [cmd], { windowsHide: true, encoding: 'utf8' });
    if (!r || r.error) return false;
    if (r.status !== 0) return false;
    return String(r.stdout || '').trim().length > 0;
  } catch (e) {
    return false;
  }
}

/** 外部依赖检测器。 */
class EnvDetector {
  /**
   * @param {{spawnWhich?: (cmd: string) => boolean}} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.spawnWhich = typeof deps.spawnWhich === 'function' ? deps.spawnWhich : defaultSpawnWhich;
  }

  /**
   * 检测 yt-dlp / ffmpeg 可用性。
   * @returns {{ytDlp: boolean, ffmpeg: boolean, missing: string[], guidance: string}}
   *   guidance：缺失项的安装引导（都可用时为空串）
   */
  detect() {
    const ytDlp = this.spawnWhich('yt-dlp') === true;
    const ffmpeg = this.spawnWhich('ffmpeg') === true;
    const missing = [];
    const tips = [];
    if (!ytDlp) { missing.push('yt-dlp'); tips.push('yt-dlp: ' + YT_DLP_GUIDANCE); }
    if (!ffmpeg) { missing.push('ffmpeg'); tips.push('ffmpeg: ' + FFMPEG_GUIDANCE); }
    return { ytDlp, ffmpeg, missing, guidance: tips.join('  |  ') };
  }
}

EnvDetector.YT_DLP_GUIDANCE = YT_DLP_GUIDANCE;
EnvDetector.FFMPEG_GUIDANCE = FFMPEG_GUIDANCE;

module.exports = { EnvDetector, defaultSpawnWhich, YT_DLP_GUIDANCE, FFMPEG_GUIDANCE };
