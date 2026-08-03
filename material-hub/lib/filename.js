// lib/filename.js —— 文件名/文件夹名清洗（素材准备规则：宣传片「保留原始英文文件名」）
// 主理人裁定 ⑦：非法字符 (/ \ : * ? " < > |) → `_`，限长 180，保留可读英文原名。
// 空白折叠为 `_`（与原型 God_of_War_2018_Launch_Trailer_1080p.mp4 一致）；
// 文件夹名可经 opts.space='keep' 保留空格，避免 "Elden Ring" 变成 "Elden_Ring" 影响可读性。

/** Windows 非法文件名字符（含控制字符）。 */
const ILLEGAL_RE = /[/\\:*?"<>|\u0000-\u001f]/g;
/** 文件名最大长度（不含扩展名）。 */
const MAX_LEN = 180;
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
   *   space: '_' 空白转下划线（默认，用于文件名）；'keep' 保留空格（用于文件夹名）
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
}

module.exports = { FilenameSanitizer, ILLEGAL_RE, MAX_LEN, FORMAT_EXT, FALLBACK_BASE };
