// 从单尺寸图标生成多尺寸 ICO（16/24/32/48/64/128/256）。
// 输入：build/icon-source.bmp（ICO 内嵌 BMP 条目，BITMAPINFOHEADER + BGRA + AND mask）。
// 用法：node scripts/build-multi-icon.js
// 输出：build/icon.ico（多尺寸 PNG 条目，Vista+ 原生支持）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-source.bmp');
const OUT = path.join(ROOT, 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function scaleBilinear(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = y * sh / dh, y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = x * sw / dw, x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c];
        const d = src[(y1 * sw + x0) * 4 + c], e = src[(y1 * sw + x1) * 4 + c];
        const top = a + (b - a) * fx, bot = d + (e - d) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return out;
}

function main() {
  const b = fs.readFileSync(SRC);
  const width = b.readUInt32LE(4);
  const heightRaw = b.readUInt32LE(8); // ICO BMP 条目 = 2×实际高度（含 AND mask）
  const height = heightRaw / 2;
  if (width !== 256 || height !== 256) throw new Error('仅支持 256×256 源图，实际 ' + width + '×' + height);
  const rowSize = width * 4;
  const pixStart = 40; // BITMAPINFOHEADER 后即像素（32bpp 无调色板）
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = b.slice(pixStart + y * rowSize, pixStart + (y + 1) * rowSize);
    // ICO BMP 像素自底向上；BGRA → RGBA
    for (let x = 0; x < width; x++) {
      const src = row[x * 4], o = ((height - 1 - y) * width + x) * 4;
      rgba[o] = row[x * 4 + 2]; rgba[o + 1] = row[x * 4 + 1];
      rgba[o + 2] = src; rgba[o + 3] = row[x * 4 + 3];
    }
  }

  const entries = [];
  const datas = [];
  for (const s of SIZES) {
    const px = s === 256 ? rgba : scaleBilinear(rgba, 256, 256, s, s);
    const png = encodePng(s, s, px);
    datas.push(png);
    entries.push(Buffer.concat([Buffer.from([
      s === 256 ? 0 : s, s === 256 ? 0 : s, 0, 0,
      0, 0, 32, 0, // planes=1, bpp=32
    ]), Buffer.alloc(8)]));
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    e.writeUInt32LE(datas[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += datas[i].length;
  });
  fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...datas]));
  console.log('written', OUT, SIZES.join('/'), 'total', offset, 'B');
}

main();
