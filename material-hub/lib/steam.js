// lib/steam.js —— 封面获取：Steam CDN 官方图为主路径，YouTube 官方宣传片 maxres 缩略图为回退
// 决策①/裁定⑥：Steam 失败 → yt-dlp 取宣传片 maxres 缩略图；两源皆失败 → 报错而非静默。
// HTTP 走 Node18+ 全局 fetch（不引 node-fetch/undici），单测经构造函数注入 fetch 替身。
const fsDefault = require('fs');
const path = require('path');
const { TrailerDownloader } = require('./trailer');

/** Steam 商店搜索接口。 */
const STORESEARCH_URL = 'https://store.steampowered.com/api/storesearch/';
/** Steam 静态资源 CDN。 */
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
/** YouTube 缩略图 CDN。 */
const YT_THUMB_CDN = 'https://i.ytimg.com/vi';
/** 规则要求的封面最小尺寸。 */
const MIN_WIDTH = 1920;
const MIN_HEIGHT = 1080;
/** 步骤名（与设计 §3.2 事件 schema 对齐）。 */
const STEP_SEARCH = '搜索封面 (Steam storesearch)';
const STEP_DOWNLOAD = '下载封面';
/** 封面统一命名（规则：封面.jpg / 封面.png）。 */
const COVER_BASE = '封面';
/** 单次图片下载超时。 */
const FETCH_TIMEOUT = 30 * 1000;

/**
 * 从图片二进制头部解析尺寸（PNG / JPEG / WEBP），纯函数、零依赖。
 * @param {Buffer|Uint8Array} input 图片字节
 * @returns {{width: number, height: number, format: string}|null} 解析失败返回 null
 */
function readImageSize(input) {
  if (!input || input.length < 16) return null;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // JPEG: FFD8 开头，扫描 SOFn 段取尺寸
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off += 1; continue; }
      const marker = buf[off + 1];
      // 填充字节 / 无长度段
      if (marker === 0xff) { off += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5), format: 'jpg' };
      }
      if (len < 2) return null;
      off += 2 + len;
    }
    return null;
  }

  // WEBP: 'RIFF' .... 'WEBP'
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h, format: 'webp' };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }
  }
  return null;
}

/**
 * 尺寸是否满足规则下限。
 * @param {{width: number, height: number}|null} size 解析出的尺寸
 * @param {{width?: number, height?: number}} [min] 下限，默认 1920×1080
 * @returns {boolean}
 */
function meetsMinSize(size, min = {}) {
  if (!size) return false;
  const minW = Number.isFinite(min.width) ? min.width : MIN_WIDTH;
  const minH = Number.isFinite(min.height) ? min.height : MIN_HEIGHT;
  return size.width >= minW && size.height >= minH;
}

/** Steam 封面获取器（含 YouTube 缩略图回退）。 */
class SteamCover {
  /**
   * @param {{fetch?: Function, fs?: object, trailer?: TrailerDownloader}} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    this.fs = deps.fs || fsDefault;
    this.trailer = deps.trailer || new TrailerDownloader();
  }

  // ── 纯函数：URL 构造与响应解析 ──

  /**
   * 构造 storesearch 查询地址。
   * @param {string} term 搜索词
   * @param {{cc?: string, l?: string}} [opts]
   * @returns {string}
   */
  searchUrl(term, opts = {}) {
    const cc = opts.cc || 'US';
    const l = opts.l || 'english';
    return STORESEARCH_URL + '?term=' + encodeURIComponent(String(term == null ? '' : term).trim())
      + '&l=' + encodeURIComponent(l) + '&cc=' + encodeURIComponent(cc);
  }

  /**
   * 从 storesearch 响应体解析首个 appid。
   * @param {object} json 响应 JSON
   * @returns {number|null}
   */
  parseAppId(json) {
    if (!json || !Array.isArray(json.items) || !json.items.length) return null;
    const hit = json.items.find((it) => it && Number.isFinite(Number(it.id)));
    if (!hit) return null;
    return Number(hit.id);
  }

  /**
   * library_hero 直链（设计指定的主路径资源）。
   * @param {number|string} appid
   * @returns {string}
   */
  heroUrl(appid) {
    return STEAM_CDN + '/' + String(appid) + '/library_hero.jpg';
  }

  /**
   * Steam 官方图候选清单（按设计主路径 library_hero 优先，
   * 其后是同为官方素材、更易满足 ≥1920×1080 的变体；全部不达标才回退 YouTube）。
   * @param {number|string} appid
   * @returns {string[]}
   */
  heroCandidates(appid) {
    const id = String(appid);
    return [
      this.heroUrl(id),
      STEAM_CDN + '/' + id + '/library_hero_2x.jpg',
      STEAM_CDN + '/' + id + '/page_bg_raw.jpg',
    ];
  }

  /**
   * YouTube maxres 缩略图直链。
   * @param {string} videoId
   * @returns {string}
   */
  youtubeThumbUrl(videoId) {
    return YT_THUMB_CDN + '/' + String(videoId) + '/maxresdefault.jpg';
  }

  // ── 带 IO 的方法 ──

  /**
   * 查询 Steam appid。
   * @param {string} term 游戏名
   * @param {{cc?: string, l?: string}} [opts]
   * @returns {Promise<number|null>}
   */
  async searchAppId(term, opts = {}) {
    const resp = await this.fetch(this.searchUrl(term, opts), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT) : undefined,
    });
    if (!resp || !resp.ok) return null;
    const json = await resp.json();
    return this.parseAppId(json);
  }

  /**
   * 下载一张图并按需做尺寸校验，通过则写入 `封面.<ext>`。
   * @param {string} url 图片直链
   * @param {string} outDir 目标目录
   * @param {{minSize?: object|null}} [opts] minSize 为 null 表示跳过尺寸校验（回退路径）
   * @returns {Promise<{ok: boolean, file?: string, path?: string, width?: number, height?: number, error?: string}>}
   */
  async downloadImage(url, outDir, opts = {}) {
    let resp = null;
    try {
      resp = await this.fetch(url, {
        headers: { Accept: 'image/*' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT) : undefined,
      });
    } catch (e) {
      return { ok: false, error: '请求失败：' + e.message };
    }
    if (!resp || !resp.ok) {
      return { ok: false, error: 'HTTP ' + ((resp && resp.status) || '?') };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const size = readImageSize(buf);
    if (!size) return { ok: false, error: '无法识别图片格式' };
    const checkMin = opts.minSize !== null;
    if (checkMin && !meetsMinSize(size, opts.minSize || {})) {
      return { ok: false, error: '尺寸不达标 ' + size.width + '×' + size.height, width: size.width, height: size.height };
    }
    const ext = size.format === 'png' ? '.png' : '.jpg';
    const file = COVER_BASE + ext;
    const dest = path.join(outDir, file);
    try {
      this.fs.writeFileSync(dest, buf);
    } catch (e) {
      return { ok: false, error: '写盘失败：' + e.message };
    }
    return { ok: true, file, path: dest, width: size.width, height: size.height, bytes: buf.length };
  }

  /**
   * 经 yt-dlp 取官方宣传片的 maxres 缩略图作为封面回退（裁定⑥）。
   * @param {string} term 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, env?: object, info?: object}} [opts]
   * @returns {Promise<object>} 同 downloadImage 结果，附 source: 'youtube'
   */
  async fetchYouTubeThumbnail(term, outDir, opts = {}) {
    const emit = opts.emit || (() => {});
    const env = opts.env || {};
    if (env.ytDlp === false) {
      return { ok: false, error: '未检测到 yt-dlp，无法取 YouTube 缩略图回退', reason: 'yt-dlp-not-found' };
    }
    emit('cover_search', STEP_SEARCH, '回退：检索官方宣传片缩略图 (yt-dlp)', null, { source: 'youtube' });
    let info = opts.info || null;
    if (!info) {
      try {
        info = await this.trailer.searchTrailer(term, { emit: () => {} });
      } catch (e) {
        return { ok: false, error: 'yt-dlp 检索失败：' + e.message, reason: 'yt-dlp-failed' };
      }
    }
    if (!info || !info.id) {
      return { ok: false, error: '未检索到可用宣传片，无缩略图可回退', reason: 'trailer-not-found' };
    }
    const url = this.youtubeThumbUrl(info.id);
    emit('cover_download', STEP_DOWNLOAD, 'GET maxresdefault.jpg', null, { url, source: 'youtube' });
    // 回退路径不再做 ≥1920×1080 校验（maxres 为 1280×720，属最后可用官方物料）
    const r = await this.downloadImage(url, outDir, { minSize: null });
    return Object.assign({ source: 'youtube', videoId: info.id }, r);
  }

  /**
   * 获取封面：Steam 主路径 → YouTube 缩略图回退 → 两源皆失败报错。
   * @param {string} term 游戏名
   * @param {string} outDir 目标目录
   * @param {{emit?: Function, env?: object, minSize?: object, cc?: string, l?: string}} [opts]
   * @returns {Promise<{ok: boolean, source?: string, file?: string, path?: string, width?: number, height?: number, appid?: number, error?: string, reason?: string}>}
   */
  async fetchCover(term, outDir, opts = {}) {
    const emit = opts.emit || (() => {});
    const minSize = opts.minSize || { width: MIN_WIDTH, height: MIN_HEIGHT };

    emit('cover_search', STEP_SEARCH, '查询 Steam storesearch：' + term, null);
    let appid = null;
    try {
      appid = await this.searchAppId(term, opts);
    } catch (e) {
      emit('log', STEP_SEARCH, '[cover] storesearch 请求失败：' + e.message, null, { level: 'err' });
    }

    if (appid) {
      emit('cover_search', STEP_SEARCH, '命中 appid=' + appid, null, { appid, source: 'steam' });
      for (const url of this.heroCandidates(appid)) {
        const asset = url.slice(url.lastIndexOf('/') + 1);
        emit('cover_download', STEP_DOWNLOAD, 'GET ' + asset, null, { url });
        const r = await this.downloadImage(url, outDir, { minSize });
        if (r.ok) {
          emit('cover_download', STEP_DOWNLOAD, r.file + ' (' + r.width + '×' + r.height + ')', true, {
            file: r.file,
            width: r.width,
            height: r.height,
            path: r.path,
            source: 'steam',
            appid,
          });
          return Object.assign({ source: 'steam', appid }, r);
        }
        emit('log', STEP_DOWNLOAD, '[cover] ' + asset + ' 不可用：' + r.error, null, { level: 'info' });
      }
    } else {
      emit('cover_search', STEP_SEARCH, 'storesearch 无命中', null);
    }

    const fb = await this.fetchYouTubeThumbnail(term, outDir, opts);
    if (fb.ok) {
      emit('cover_download', STEP_DOWNLOAD, fb.file + ' (' + fb.width + '×' + fb.height + ' · YouTube 回退)', true, {
        file: fb.file,
        width: fb.width,
        height: fb.height,
        path: fb.path,
        source: 'youtube',
      });
      return fb;
    }
    return {
      ok: false,
      reason: 'cover-both-failed',
      error: 'Steam 与 YouTube 缩略图均获取失败' + (fb.error ? '（' + fb.error + '）' : ''),
      appid: appid || undefined,
    };
  }
}

module.exports = {
  SteamCover,
  readImageSize,
  meetsMinSize,
  STORESEARCH_URL,
  STEAM_CDN,
  YT_THUMB_CDN,
  MIN_WIDTH,
  MIN_HEIGHT,
  STEP_SEARCH,
  STEP_DOWNLOAD,
  COVER_BASE,
};
