// test/imagesize.test.js —— 图片头部尺寸解析（纯函数，零 IO）
// 从旧 steam.test.js 迁移并补强：cover.js 的「下载后校验真实分辨率」完全依赖这几个函数，
// 解析错一位就会把 720p 图当成达标封面采纳，因此必须锁死。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readImageSize,
  meetsMinSize,
  extForImageFormat,
  MIN_WIDTH,
  MIN_HEIGHT,
} = require('../lib/imagesize');

/**
 * 构造最小 PNG 头（IHDR 里写入宽高）。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function pngBuf(w, h) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/**
 * 构造最小 JPEG（FFD8 + APP0 段 + SOF0 段）。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function jpegBuf(w, h) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2);   // 段长
  sof[4] = 8;                // 精度
  sof.writeUInt16BE(h, 5);   // 高在前
  sof.writeUInt16BE(w, 7);   // 宽在后
  sof[9] = 3; sof[10] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(8)]);
}

/**
 * 构造最小 WEBP/VP8X。
 * @param {number} w 宽
 * @param {number} h 高
 * @returns {Buffer}
 */
function webpBuf(w, h) {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  const wm = w - 1;
  const hm = h - 1;
  b[24] = wm & 0xff; b[25] = (wm >> 8) & 0xff; b[26] = (wm >> 16) & 0xff;
  b[27] = hm & 0xff; b[28] = (hm >> 8) & 0xff; b[29] = (hm >> 16) & 0xff;
  return b;
}

test('readImageSize 解析 PNG 宽高', () => {
  assert.deepEqual(readImageSize(pngBuf(1920, 1080)), { width: 1920, height: 1080, format: 'png' });
  assert.deepEqual(readImageSize(pngBuf(3840, 2160)), { width: 3840, height: 2160, format: 'png' });
});

test('readImageSize 解析 JPEG 宽高（SOF0 里高在前宽在后，顺序不能颠倒）', () => {
  assert.deepEqual(readImageSize(jpegBuf(1920, 1080)), { width: 1920, height: 1080, format: 'jpg' });
  // 非正方形用例专门防「宽高读反」：1280×720 若读反会变成 720×1280 而误判达标
  assert.deepEqual(readImageSize(jpegBuf(1280, 720)), { width: 1280, height: 720, format: 'jpg' });
});

test('readImageSize 解析 WEBP/VP8X 宽高', () => {
  assert.deepEqual(readImageSize(webpBuf(1920, 1080)), { width: 1920, height: 1080, format: 'webp' });
});

test('readImageSize 对非图片 / 过短输入返回 null', () => {
  assert.equal(readImageSize(null), null);
  assert.equal(readImageSize(Buffer.alloc(0)), null);
  assert.equal(readImageSize(Buffer.from('ab')), null);
  // HTML 错误页（壁纸站 404 常返回 HTML）必须识别为非图片
  assert.equal(readImageSize(Buffer.from('<!DOCTYPE html><html><head><title>404</title></head></html>')), null);
});

test('meetsMinSize 默认下限为规范的 1920×1080', () => {
  assert.equal(MIN_WIDTH, 1920);
  assert.equal(MIN_HEIGHT, 1080);
  assert.equal(meetsMinSize({ width: 1920, height: 1080 }), true);
  assert.equal(meetsMinSize({ width: 3840, height: 2160 }), true);
  // Steam library_hero 的真实尺寸 1920×620 —— 正是旧实现永远达不到标准的物证
  assert.equal(meetsMinSize({ width: 1920, height: 620 }), false);
  // YouTube maxresdefault 的真实尺寸 1280×720
  assert.equal(meetsMinSize({ width: 1280, height: 720 }), false);
  assert.equal(meetsMinSize({ width: 1919, height: 1080 }), false);
  assert.equal(meetsMinSize(null), false);
});

test('meetsMinSize 支持自定义下限', () => {
  assert.equal(meetsMinSize({ width: 1280, height: 720 }, { width: 1280, height: 720 }), true);
  assert.equal(meetsMinSize({ width: 1280, height: 720 }, { width: 1281, height: 720 }), false);
});

test('extForImageFormat 映射扩展名', () => {
  assert.equal(extForImageFormat('png'), '.png');
  assert.equal(extForImageFormat('webp'), '.webp');
  assert.equal(extForImageFormat('jpg'), '.jpg');
  assert.equal(extForImageFormat('JPEG'), '.jpg');
  assert.equal(extForImageFormat(''), '.jpg');
  assert.equal(extForImageFormat(null), '.jpg');
});
