// lib/trailer.js —— 官方宣传片检索 / 下载 / 转码（spawn 系统 PATH 的 yt-dlp、ffmpeg）
// 规则：YouTube 官方频道 launch/release trailer、1080p+、保留原始英文文件名、
//       .webm 用 `ffmpeg -i in.webm -c:v copy -c:a aac out.mp4` 转 .mp4。
// 所有参数构造均为纯函数，spawn 经构造函数注入，单测不依赖 yt-dlp/网络。
const { spawn: spawnDefault } = require('child_process');
const fsDefault = require('fs');
const path = require('path');
const { FilenameSanitizer } = require('./filename');

/** 检索关键词模板（规则：launch trailer / release trailer / official trailer）。 */
const SEARCH_SUFFIX = 'official launch trailer';
/** 步骤名（与设计 §3.2 事件 schema 对齐）。 */
const STEP_SEARCH = '搜索官方宣传片 (yt-dlp)';
const STEP_DOWNLOAD = '下载宣传片';
const STEP_TRANSCODE = '转码 .webm → .mp4';
/** 子进程超时（检索 90s / 下载 20min / 转码 20min），避免卡死 SSE。 */
const TIMEOUT_SEARCH = 90 * 1000;
const TIMEOUT_DOWNLOAD = 20 * 60 * 1000;

/**
 * 运行外部命令，逐行回调 stdout/stderr。
 * @param {string} cmd 命令名
 * @param {string[]} args 参数
 * @param {{spawn?: Function, onLine?: (line: string, stream: string) => void, timeout?: number, cwd?: string}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runCommand(cmd, args, opts = {}) {
  const spawnFn = opts.spawn || spawnDefault;
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : () => {};
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : TIMEOUT_DOWNLOAD;
  return new Promise((resolve, reject) => {
    let child = null;
    try {
      child = spawnFn(cmd, args, { windowsHide: true, cwd: opts.cwd });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let tailOut = '';
    let tailErr = '';

    const pump = (chunk, stream) => {
      const text = String(chunk);
      if (stream === 'stdout') { stdout += text; tailOut += text; } else { stderr += text; tailErr += text; }
      let buf = stream === 'stdout' ? tailOut : tailErr;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line, stream);
      }
      if (stream === 'stdout') tailOut = buf; else tailErr = buf;
    };

    if (child.stdout && child.stdout.on) child.stdout.on('data', (c) => pump(c, 'stdout'));
    if (child.stderr && child.stderr.on) child.stderr.on('data', (c) => pump(c, 'stderr'));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) {}
      const err = new Error(cmd + ' 执行超时（' + Math.round(timeout / 1000) + 's）');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeout);
    if (timer.unref) timer.unref();

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

/** 官方宣传片下载器。 */
class TrailerDownloader {
  /**
   * @param {{spawn?: Function, fs?: object, sanitizer?: FilenameSanitizer}} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.spawn = deps.spawn || spawnDefault;
    this.fs = deps.fs || fsDefault;
    this.sanitizer = deps.sanitizer || new FilenameSanitizer();
  }

  // ── 纯函数：参数构造与结果解析（单测主战场）──

  /**
   * 构造 yt-dlp 检索参数（只取元数据，不下载）。
   * @param {string} name 游戏名
   * @returns {string[]}
   */
  buildSearchArgs(name) {
    const term = String(name == null ? '' : name).trim();
    return [
      'ytsearch1:' + term + ' ' + SEARCH_SUFFIX,
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--skip-download',
    ];
  }

  /**
   * 解析 yt-dlp --dump-single-json 输出（ytsearch 返回 playlist，单视频返回对象）。
   * @param {string} raw stdout 文本
   * @returns {{id: string, title: string, url: string, duration: number, channel: string}|null}
   */
  parseSearchResult(raw) {
    let json = null;
    try {
      json = JSON.parse(String(raw == null ? '' : raw).trim());
    } catch (e) {
      return null;
    }
    if (!json || typeof json !== 'object') return null;
    const item = Array.isArray(json.entries) ? json.entries[0] : json;
    if (!item || !item.id) return null;
    return {
      id: String(item.id),
      title: String(item.title || item.fulltitle || item.id),
      url: String(item.webpage_url || item.url || ('https://www.youtube.com/watch?v=' + item.id)),
      duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : 0,
      channel: String(item.channel || item.uploader || ''),
    };
  }

  /**
   * 构造 yt-dlp 下载参数。
   * ffmpeg 可用时走「最佳视频+音频合流为 mp4」；不可用时只能取单文件流（可能是 webm）。
   * @param {string} url 视频页地址
   * @param {string} outTemplate 输出模板（含 %(ext)s）
   * @param {{ffmpeg?: boolean}} [env] 外部依赖可用性
   * @returns {string[]}
   */
  buildDownloadArgs(url, outTemplate, env = {}) {
    const hasFfmpeg = env.ffmpeg !== false;
    const format = hasFfmpeg
      ? 'bv*[height>=1080]+ba/b[height>=1080]/bv*+ba/b'
      : 'b[height>=1080]/b';
    const args = ['-f', format];
    if (hasFfmpeg) args.push('--merge-output-format', 'mp4');
    args.push('--no-playlist', '--no-warnings', '--newline', '--no-part', '-o', outTemplate, url);
    return args;
  }

  /**
   * 是否需要转码（规则：.webm → .mp4）。
   * @param {string} file 文件名或路径
   * @returns {boolean}
   */
  needsTranscode(file) {
    return /\.webm$/i.test(String(file == null ? '' : file));
  }

  /**
   * 构造 ffmpeg 转码参数（严格对齐规则文档给出的命令）。
   * @param {string} input 输入 .webm 路径
   * @param {string} output 输出 .mp4 路径
   * @returns {string[]}
   */
  buildTranscodeArgs(input, output) {
    return ['-y', '-i', input, '-c:v', 'copy', '-c:a', 'aac', output];
  }

  /**
   * 在目录中按基名查找 yt-dlp 实际产出的文件（扩展名由 %(ext)s 决定）。
   * @param {string} dir 目录
   * @param {string} base 清洗后的基名（不含扩展名）
   * @returns {string|null} 文件名；未找到返回 null
   */
  findDownloaded(dir, base) {
    let entries = [];
    try { entries = this.fs.readdirSync(dir); } catch (e) { return null; }
    const prefix = base + '.';
    const hit = entries.filter((n) => n.startsWith(prefix) && !/\.(part|ytdl|temp)$/i.test(n));
    if (!hit.length) return null;
    // 优先 mp4，其次任意（webm/mkv）
    hit.sort((a, b) => (/\.mp4$/i.test(b) ? 1 : 0) - (/\.mp4$/i.test(a) ? 1 : 0));
    return hit[0];
  }

  // ── 带 IO 的编排方法 ──

  /**
   * 检索官方宣传片元数据。
   * @param {string} name 游戏名
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<object|null>} 命中信息；未命中返回 null
   */
  async searchTrailer(name, opts = {}) {
    const emit = opts.emit || (() => {});
    const args = this.buildSearchArgs(name);
    emit('trailer_search', STEP_SEARCH, '检索 “' + name + ' ' + SEARCH_SUFFIX + '”…', null);
    const r = await runCommand('yt-dlp', args, {
      spawn: this.spawn,
      timeout: TIMEOUT_SEARCH,
      onLine: (line, stream) => {
        if (stream === 'stderr') emit('log', STEP_SEARCH, '[yt-dlp] ' + line, null, { level: 'info' });
      },
    });
    const info = this.parseSearchResult(r.stdout);
    if (!info) {
      emit('trailer_search', STEP_SEARCH, '未检索到可用宣传片', null);
      return null;
    }
    emit('trailer_search', STEP_SEARCH, '命中 ' + (info.channel ? info.channel + ' · ' : '') + info.title, null, {
      title: info.title,
      url: info.url,
      channel: info.channel,
    });
    return info;
  }

  /**
   * 下载宣传片（保留原始英文标题作为文件名，经 FilenameSanitizer 清洗）。
   * @param {string} name 游戏名
   * @param {string} dir 目标目录
   * @param {{ytDlp?: boolean, ffmpeg?: boolean}} env 外部依赖可用性
   * @param {{info?: object, emit?: Function}} [opts] info 为已检索到的元数据，避免重复检索
   * @returns {Promise<{ok: boolean, file?: string, path?: string, title?: string, error?: string, reason?: string}>}
   */
  async download(name, dir, env = {}, opts = {}) {
    const emit = opts.emit || (() => {});
    if (env.ytDlp === false) {
      return { ok: false, reason: 'yt-dlp-not-found', error: '未检测到 yt-dlp，无法下载宣传片' };
    }
    const info = opts.info || (await this.searchTrailer(name, { emit }));
    if (!info) {
      return { ok: false, reason: 'trailer-not-found', error: '未搜索到官方宣传片' };
    }
    const base = this.sanitizer.sanitize(info.title, { max: 160 });
    const outTemplate = path.join(dir, base + '.%(ext)s');
    const args = this.buildDownloadArgs(info.url, outTemplate, env);
    emit('trailer_download', STEP_DOWNLOAD, '下载中…', null, { url: info.url, title: info.title });
    let r = null;
    try {
      r = await runCommand('yt-dlp', args, {
        spawn: this.spawn,
        timeout: TIMEOUT_DOWNLOAD,
        onLine: (line) => emit('log', STEP_DOWNLOAD, '[yt-dlp] ' + line, null, { level: 'info' }),
      });
    } catch (e) {
      return { ok: false, reason: 'yt-dlp-failed', error: 'yt-dlp 执行失败：' + e.message };
    }
    const produced = this.findDownloaded(dir, base);
    if (r.code !== 0 && !produced) {
      return { ok: false, reason: 'yt-dlp-failed', error: 'yt-dlp 退出码 ' + r.code };
    }
    if (!produced) {
      return { ok: false, reason: 'trailer-file-missing', error: '下载完成但未找到产出文件' };
    }
    return { ok: true, file: produced, path: path.join(dir, produced), title: info.title, url: info.url };
  }

  /**
   * 按规则把 .webm 转成 .mp4（视频流直拷、音频转 aac）。
   * @param {string} file 已下载的文件名
   * @param {string} dir 所在目录
   * @param {{ffmpeg?: boolean}} env 外部依赖可用性
   * @param {{emit?: Function}} [opts]
   * @returns {Promise<{file: string, converted: boolean, reason?: string, error?: string}>}
   */
  async transcodeIfNeeded(file, dir, env = {}, opts = {}) {
    const emit = opts.emit || (() => {});
    if (!this.needsTranscode(file)) return { file, converted: false };
    if (env.ffmpeg === false) {
      emit('trailer_transcode', STEP_TRANSCODE, '未检测到 ffmpeg，保留 .webm 原文件', null, {
        reason: 'ffmpeg-not-found',
      });
      return { file, converted: false, reason: 'ffmpeg-not-found' };
    }
    const input = path.join(dir, file);
    const outName = file.replace(/\.webm$/i, '.mp4');
    const output = path.join(dir, outName);
    emit('trailer_transcode', STEP_TRANSCODE, 'ffmpeg 转码中…', null, { from: file, to: outName });
    let r = null;
    try {
      r = await runCommand('ffmpeg', this.buildTranscodeArgs(input, output), {
        spawn: this.spawn,
        timeout: TIMEOUT_DOWNLOAD,
        onLine: (line) => emit('log', STEP_TRANSCODE, '[ffmpeg] ' + line, null, { level: 'info' }),
      });
    } catch (e) {
      emit('trailer_transcode', STEP_TRANSCODE, 'ffmpeg 转码失败，保留 .webm：' + e.message, null, {
        reason: 'ffmpeg-failed',
      });
      return { file, converted: false, reason: 'ffmpeg-failed', error: e.message };
    }
    if (r.code !== 0) {
      emit('trailer_transcode', STEP_TRANSCODE, 'ffmpeg 退出码 ' + r.code + '，保留 .webm', null, {
        reason: 'ffmpeg-failed',
      });
      return { file, converted: false, reason: 'ffmpeg-failed', error: 'ffmpeg 退出码 ' + r.code };
    }
    // 转码成功后删掉原 .webm（规则要求最终 1 个视频文件）
    try { this.fs.unlinkSync(input); } catch (e) {}
    emit('trailer_transcode', STEP_TRANSCODE, '已转为 ' + outName, true, { file: outName, converted: true });
    return { file: outName, converted: true };
  }
}

module.exports = {
  TrailerDownloader,
  runCommand,
  SEARCH_SUFFIX,
  STEP_SEARCH,
  STEP_DOWNLOAD,
  STEP_TRANSCODE,
};
