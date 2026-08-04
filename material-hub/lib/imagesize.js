// lib/imagesize.js —— 图片二进制头部尺寸解析（纯函数，零依赖，零 IO）
// 原先内联在 lib/steam.js；steam 源已废弃（Steam library_hero 最大只有 1920×620，
// 物理上永远达不到规范要求的 1920×1080），故把这两个通用纯函数抽出来独立复用，
// 供 lib/cover.js 在「下载后、采纳前」做本地尺寸校验，避免重复造轮子。

/** 封面最小尺寸（1280×720：HD 壁纸站在保证质量前提下更易命中）。 */
const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;

/**
 * 从图片二进制头部解析尺寸（PNG / JPEG / WEBP）。
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
 * 尺寸是否满足封面下限（默认 1280×720）。
 * @param {{width: number, height: number}|null} size 解析出的尺寸
 * @param {{width?: number, height?: number}} [min] 下限
 * @returns {boolean}
 */
function meetsMinSize(size, min = {}) {
  if (!size) return false;
  const minW = Number.isFinite(min.width) ? min.width : MIN_WIDTH;
  const minH = Number.isFinite(min.height) ? min.height : MIN_HEIGHT;
  return size.width >= minW && size.height >= minH;
}

/**
 * 图片格式 → 扩展名。
 * @param {string} format readImageSize 返回的 format
 * @returns {string} 形如 '.jpg'
 */
function extForImageFormat(format) {
  const f = String(format == null ? '' : format).toLowerCase();
  if (f === 'png') return '.png';
  if (f === 'webp') return '.webp';
  return '.jpg';
}

module.exports = { readImageSize, meetsMinSize, extForImageFormat, MIN_WIDTH, MIN_HEIGHT };
