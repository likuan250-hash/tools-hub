// lib/probe.js —— 媒体探测与处理（ffprobe 分辨率校验 / ffmpeg 抽帧 / ffmpeg 转 JPG）
//
// 规范《验证命令》：
//   ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 <file>
// 规范《封面来源优先级》第 7 级（最后兜底）：
//   ffmpeg -ss 00:00:05 -i {视频} -vframes 1 -q:v 2 封面.jpg
//
// 二进制路径由 lib/env.js 给出（内置 @ffmpeg-installer / @ffprobe-installer 的绝对路径），
// 不依赖系统 PATH。所有参数构造都是纯函数，spawn 经构造函数注入，单测不跑真实二进制。
const { spawn: spawnDefault } = require('child_process');
const fsDefault = require('fs');
const { runCommand } = require('./runner');

/** 探测/抽帧超时（媒体文件本地处理，60s 足够）。 */
const TIMEOUT_PROBE = 60 * 1000;
/** 转码/抽帧超时。 */
const TIMEOUT_FFMPEG = 5 * 60 * 1000;
/** 规范指定的抽帧时间点。 */
const DEFAULT_SEEK = '00:00:05';
/** 抽帧失败时依次回退的时间点（片头可能是纯黑或视频短于 5s）。 */
const FALLBACK_SEEKS = ['00:00:15', '00:00:30', '00:00:01'];

/** 媒体探测器（ffprobe + ffmpeg 的薄封装）。 */
class MediaProbe {
  /**
   * @param {{
   *   spawn?: Function, fs?: object,
   *   ffprobePath?: string|null, ffmpegPath?: string|null
   * }} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.spawn = deps.spawn || spawnDefault;
    this.fs = deps.fs || fsDefault;
    this.ffprobePath = deps.ffprobePath || null;
    this.ffmpegPath = deps.ffmpegPath || null;
  }

  /**
   * 更新二进制路径（CollectService 在 env 探测完成后注入）。
   * @param {{ffprobePath?: string|null, ffmpegPath?: string|null}} paths 路径
   */
  setBinaries(paths = {}) {
    if (paths.ffprobePath !== undefined) this.ffprobePath = paths.ffprobePath;
    if (paths.ffmpegPath !== undefined) this.ffmpegPath = paths.ffmpegPath;
  }

  // ── 纯函数：参数构造与输出解析（单测主战场）──

  /**
   * 构造 ffprobe 分辨率查询参数（逐字对齐规范《验证命令》）。
   * @param {string} file 媒体文件路径
   * @returns {string[]}
   */
  buildProbeArgs(file) {
    return [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      String(file == null ? '' : file),
    ];
  }

  /**
   * 解析 ffprobe csv=p=0 输出，如 `1920,1080`。
   * @param {string} raw stdout 文本
   * @returns {{width: number, height: number}|null} 解析失败返回 null
   */
  parseProbeOutput(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    // 多流时可能有多行，取第一行有效数据
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d+)\s*,\s*(\d+)/.exec(line.trim());
      if (!m) continue;
      const width = Number.parseInt(m[1], 10);
      const height = Number.parseInt(m[2], 10);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { width, height };
      }
    }
    return null;
  }

  /**
   * 构造 ffmpeg 抽帧参数（逐字对齐规范第 7 级封面兜底命令，额外加 -y 以便覆盖重跑）。
   * @param {string} video 输入视频路径
   * @param {string} output 输出图片路径
   * @param {string} [seek='00:00:05'] 抽帧时间点
   * @returns {string[]}
   */
  buildExtractFrameArgs(video, output, seek = DEFAULT_SEEK) {
    return [
      '-y',
      '-ss', String(seek || DEFAULT_SEEK),
      '-i', String(video == null ? '' : video),
      '-vframes', '1',
      '-q:v', '2',
      String(output == null ? '' : output),
    ];
  }

  /**
   * 构造 ffmpeg 图片转 JPG 参数（规范要求封面必须是 JPG / 封面.jpg）。
   * @param {string} input 输入图片路径（png/webp）
   * @param {string} output 输出 .jpg 路径
   * @returns {string[]}
   */
  buildConvertToJpgArgs(input, output) {
    return [
      '-y',
      '-i', String(input == null ? '' : input),
      '-q:v', '2',
      String(output == null ? '' : output),
    ];
  }

  // ── 带 IO 的方法 ──

  /**
   * 用 ffprobe 读取媒体分辨率。
   * @param {string} file 媒体文件路径
   * @param {{emit?: Function, step?: string}} [opts]
   * @returns {Promise<{ok: boolean, width?: number, height?: number, error?: string, reason?: string}>}
   */
  async probeSize(file, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    if (!this.ffprobePath) {
      return { ok: false, reason: 'ffprobe-not-found', error: '未定位到 ffprobe，跳过分辨率校验' };
    }
    let r = null;
    try {
      r = await runCommand(this.ffprobePath, this.buildProbeArgs(file), {
        spawn: this.spawn,
        timeout: TIMEOUT_PROBE,
      });
    } catch (e) {
      return { ok: false, reason: 'ffprobe-failed', error: 'ffprobe 执行失败：' + e.message };
    }
    const size = this.parseProbeOutput(r.stdout);
    if (!size) {
      emit('log', opts.step || '校验分辨率', '[ffprobe] 无法解析输出：' + String(r.stderr || '').trim(), null, {
        level: 'info',
      });
      return { ok: false, reason: 'probe-parse-failed', error: 'ffprobe 未返回可解析的分辨率' };
    }
    return { ok: true, width: size.width, height: size.height };
  }

  /**
   * 从视频抽一帧作为封面（规范第 7 级兜底）。
   * 首选 00:00:05；失败则依次回退到 15s / 30s / 1s，尽最大努力拿到一帧。
   * @param {string} video 视频路径
   * @param {string} output 输出图片路径（.jpg）
   * @param {{emit?: Function, step?: string, seeks?: string[]}} [opts]
   * @returns {Promise<{ok: boolean, path?: string, seek?: string, error?: string, reason?: string}>}
   */
  async extractFrame(video, output, opts = {}) {
    const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
    const step = opts.step || '抽帧兜底封面';
    if (!this.ffmpegPath) {
      return { ok: false, reason: 'ffmpeg-not-found', error: '未定位到 ffmpeg，无法抽帧兜底' };
    }
    const seeks = Array.isArray(opts.seeks) && opts.seeks.length
      ? opts.seeks
      : [DEFAULT_SEEK].concat(FALLBACK_SEEKS);

    let lastError = '未执行';
    for (const seek of seeks) {
      emit('cover_extract', step, 'ffmpeg 抽帧 @' + seek + '…', null, { seek });
      let r = null;
      try {
        r = await runCommand(this.ffmpegPath, this.buildExtractFrameArgs(video, output, seek), {
          spawn: this.spawn,
          timeout: TIMEOUT_FFMPEG,
        });
      } catch (e) {
        lastError = 'ffmpeg 执行失败：' + e.message;
        continue;
      }
      if (r.code !== 0) {
        lastError = 'ffmpeg 退出码 ' + r.code;
        continue;
      }
      if (!this.fileExists(output)) {
        lastError = 'ffmpeg 未产出图片文件';
        continue;
      }
      return { ok: true, path: output, seek };
    }
    return { ok: false, reason: 'extract-failed', error: lastError };
  }

  /**
   * 用 ffmpeg 把非 JPG 图片转成 JPG（规范要求封面统一为 封面.jpg）。
   * @param {string} input 输入图片路径
   * @param {string} output 输出 .jpg 路径
   * @returns {Promise<{ok: boolean, path?: string, error?: string, reason?: string}>}
   */
  async convertToJpg(input, output) {
    if (!this.ffmpegPath) {
      return { ok: false, reason: 'ffmpeg-not-found', error: '未定位到 ffmpeg，无法转 JPG' };
    }
    let r = null;
    try {
      r = await runCommand(this.ffmpegPath, this.buildConvertToJpgArgs(input, output), {
        spawn: this.spawn,
        timeout: TIMEOUT_FFMPEG,
      });
    } catch (e) {
      return { ok: false, reason: 'ffmpeg-failed', error: 'ffmpeg 执行失败：' + e.message };
    }
    if (r.code !== 0) {
      return { ok: false, reason: 'ffmpeg-failed', error: 'ffmpeg 退出码 ' + r.code };
    }
    if (!this.fileExists(output)) {
      return { ok: false, reason: 'ffmpeg-failed', error: 'ffmpeg 未产出 JPG 文件' };
    }
    return { ok: true, path: output };
  }

  /**
   * 文件是否存在（异常一律视为不存在）。
   * @param {string} file 路径
   * @returns {boolean}
   */
  fileExists(file) {
    try {
      return this.fs.existsSync(file) === true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = {
  MediaProbe,
  DEFAULT_SEEK,
  FALLBACK_SEEKS,
  TIMEOUT_PROBE,
  TIMEOUT_FFMPEG,
};
