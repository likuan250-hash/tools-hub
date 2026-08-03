// lib/filename.js —— 文件名/文件夹名清洗 + 规范要求的视频命名构造
// 非法字符 (/ \ : * ? " < > |) → `_`，限长 180。
// 空白折叠为 `_`（宣传片原始英文名场景）；opts.space='keep' 保留空格（文件夹名 / 中文命名场景）。
//
// 规范《素材搜集规则》「视频命名规范」：
//   Launch Trailer：【游戏XXX】游戏名 英文版名 Launch Trailer 免费学习版下载.mp4
//   主视频        ：【游戏XXX】游戏名 版本描述 免费学习版下载.mp4

/** Windows 非法文件名字符（含控制字符）。 */
const ILLEGAL_RE = /[/\\:*?"<>|\u0000-\u001f]/g;
/** 文件名最大长度（不含扩展名）。 */
const MAX_LEN = 180;
/** 编号最小位宽（与规范示例 【游戏255】 对齐）；lib/name.js 复用本常量避免两处漂移。 */
const INDEX_PAD = 3;
/** 规范固定后缀（所有视频文件名结尾）。 */
const FREE_SUFFIX = '免费学习版下载';
/** Launch Trailer 类型标识（规范示例：… The Two Masters Launch Trailer 免费学习版下载.mp4）。 */
const LAUNCH_MARK = 'Launch Trailer';
/** 主视频默认版本描述（规范：官方中文 / 全DLC / 免安装硬盘版）。 */
const DEFAULT_VERSION_DESC = '官方中文+全DLC+免安装硬盘版';
/** yt-dlp 常见容器格式 → 扩展名。 */
const FORMAT_EXT = {
  mp4: '.mp4',
  m4v: '.mp4',
  webm: '.webm',
  mkv: '.mkv',
  mov: '.mov',
  flv: '.flv',
  jpg: '.jpg',
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
};
/** 无法得出可用名时的兜底基名。 */
const FALLBACK_BASE = 'trailer';

/** 文件名清洗器（纯函数集合，无 IO，便于单测）。 */
class FilenameSanitizer {
  /**
   * 截断到 max 长度（按字符计），不破坏前后空白语义。
   * @param {string} raw 原始串
   * @param {number} [max=180] 最大长度
   * @returns {string}
   */
  truncate(raw, max = MAX_LEN) {
    const s = String(raw == null ? '' : raw);
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_LEN;
    return s.length <= limit ? s : s.slice(0, limit);
  }

  /**
   * 清洗为合法且可读的文件/文件夹基名。
   * @param {string} raw 原始名（可能来自 yt-dlp 标题）
   * @param {{space?: '_'|'keep', max?: number}} [opts]
   *   space: '_' 空白转下划线（默认，用于英文原名）；'keep' 保留空格（用于文件夹名/中文命名）
   * @returns {string} 清洗后的基名（永不为空）
   */
  sanitize(raw, opts = {}) {
    const space = opts.space === 'keep' ? 'keep' : '_';
    const max = opts.max == null ? MAX_LEN : opts.max;
    let s = String(raw == null ? '' : raw);
    s = s.replace(ILLEGAL_RE, '_');
    // 空白处理：折叠连续空白；文件名场景转为下划线
    s = s.replace(/\s+/g, space === 'keep' ? ' ' : '_');
    // 折叠重复下划线，去掉首尾的下划线/点/空格（Windows 不允许以点或空格结尾）
    s = s.replace(/_{2,}/g, '_').replace(/^[._\s]+/, '').replace(/[._\s]+$/, '');
    s = this.truncate(s, max).replace(/[._\s]+$/, '');
    return s || FALLBACK_BASE;
  }

  /**
   * 容器格式 → 扩展名。
   * @param {string} fmt 如 'mp4' / '.WEBM' / 'unknown'
   * @returns {string} 形如 '.mp4'；未知格式回退 '.mp4'
   */
  extForFormat(fmt) {
    const key = String(fmt == null ? '' : fmt).trim().toLowerCase().replace(/^\./, '');
    return FORMAT_EXT[key] || '.mp4';
  }

  /**
   * 组合出最终文件名：清洗基名 + 限长 + 扩展名。
   * @param {string} rawTitle 原始标题
   * @param {string} fmt 容器格式或扩展名
   * @returns {string} 如 'God_of_War_Launch_Trailer.mp4'
   */
  buildFileName(rawTitle, fmt) {
    const ext = this.extForFormat(fmt);
    return this.sanitize(rawTitle, { max: MAX_LEN - ext.length }) + ext;
  }

  /**
   * 编号前缀（与 NameResolver.buildFolderName 同源，保证文件名与文件夹名编号一致）。
   * @param {number} index 编号
   * @returns {string} 如 '【游戏267】'
   */
  indexPrefix(index) {
    const n = Number.isFinite(Number(index)) ? Math.max(0, Math.floor(Number(index))) : 0;
    return '【游戏' + String(n).padStart(INDEX_PAD, '0') + '】';
  }

  /**
   * 用空格拼接若干片段，自动丢弃空片段并折叠多余空格。
   * @param {Array<string>} parts 片段
   * @returns {string}
   */
  joinParts(parts) {
    return (Array.isArray(parts) ? parts : [])
      .map((p) => String(p == null ? '' : p).trim())
      .filter((p) => p.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 构造 Launch Trailer 文件名。
   * 规范格式：`【游戏XXX】游戏名 英文版名 Launch Trailer 免费学习版下载.mp4`
   * 规范同时给出无英文名的示例（`【游戏264】光环：战役进化 免费学习版下载.mp4`），
   * 故 englishName 为空且 mark 显式置空时可省略类型标识。
   * @param {number} index 素材编号
   * @param {string} gameName 游戏名（中文名优先）
   * @param {{englishName?: string, mark?: string, ext?: string}} [opts]
   *   englishName 英文版名（如 'The Two Masters'）；mark 类型标识，默认 'Launch Trailer'，传 '' 省略
   * @returns {string} 如 '【游戏267】忍者龙剑传4 The Two Masters Launch Trailer 免费学习版下载.mp4'
   */
  buildLaunchTrailerName(index, gameName, opts = {}) {
    const ext = this.extForFormat(opts.ext == null ? 'mp4' : opts.ext);
    const mark = opts.mark === undefined ? LAUNCH_MARK : String(opts.mark || '');
    const body = this.joinParts([
      this.indexPrefix(index) + this.sanitize(gameName, { space: 'keep', max: 80 }),
      opts.englishName ? this.sanitize(opts.englishName, { space: 'keep', max: 60 }) : '',
      mark,
      FREE_SUFFIX,
    ]);
    return this.sanitize(body, { space: 'keep', max: MAX_LEN - ext.length }) + ext;
  }

  /**
   * 构造主视频（游戏版本素材）文件名。
   * 规范格式：`【游戏XXX】游戏名 版本描述 免费学习版下载.mp4`
   * @param {number} index 素材编号
   * @param {string} gameName 游戏名
   * @param {{versionDesc?: string, ext?: string}} [opts] versionDesc 默认 '官方中文+全DLC+免安装硬盘版'
   * @returns {string} 如 '【游戏265】模拟人生4 官方中文+全DLC+免安装硬盘版 免费学习版下载.mp4'
   */
  buildMainVideoName(index, gameName, opts = {}) {
    const ext = this.extForFormat(opts.ext == null ? 'mp4' : opts.ext);
    const desc = opts.versionDesc === undefined ? DEFAULT_VERSION_DESC : String(opts.versionDesc || '');
    const body = this.joinParts([
      this.indexPrefix(index) + this.sanitize(gameName, { space: 'keep', max: 80 }),
      desc ? this.sanitize(desc, { space: 'keep', max: 60 }) : '',
      FREE_SUFFIX,
    ]);
    return this.sanitize(body, { space: 'keep', max: MAX_LEN - ext.length }) + ext;
  }
}

module.exports = {
  FilenameSanitizer,
  ILLEGAL_RE,
  MAX_LEN,
  INDEX_PAD,
  FORMAT_EXT,
  FALLBACK_BASE,
  FREE_SUFFIX,
  LAUNCH_MARK,
  DEFAULT_VERSION_DESC,
};
