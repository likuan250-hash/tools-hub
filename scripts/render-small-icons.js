// 为小尺寸手绘简化版图标（16/24px），替代纯下采样渲染。
// 大尺寸下复杂角色细节会糊成一团，小尺寸必须按网格重画：
// 只保留主色块（蓝臂/橙脸/红颊/黄冠/粉发/黑眼）+ 白底。
// 用法：node scripts/render-small-icons.js
// 输出：覆盖 build/.icon-render/icon-{16,24}.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'build', '.icon-render');

// 调色板：与 icon-source.svg 主色一致
const PALETTE = {
  '.': [0, 0, 0, 0],          // 透明背景
  O: [254, 125, 35, 255],    // #fe7d23 橙（脸/主体）
  R: [250, 85, 54, 255],     // #fa5536 红（右颊/下颌）
  B: [18, 172, 228, 255],    // #12ace4 蓝（左右手臂）
  P: [240, 73, 178, 255],    // #f049b2 粉（右发）
  Y: [248, 202, 6, 255],     // #f8ca06 黄（顶冠）
  '#': [4, 3, 2, 255],       // #040302 黑（眼睛）
};

const GRIDS = {
  16: [
    '................',
    '................',
    '................',
    '......YY........',
    '.....YYYYPP.....',
    '....OOOOYPPP....',
    '..BBOOOOOPPP....',
    '..BBO#OOORR.....',
    '..BBO#OOORR.....',
    '..BBOOOOORR.....',
    '..BBOOOOORR.....',
    '..BBOOOORRR.....',
    '..BBOORRRRR.....',
    '..BBBBBBBBB.....',
    '................',
    '................',
  ],
  24: [
    '........................',
    '........................',
    '........................',
    '........................',
    '........................',
    '.........YYYYY..........',
    '........YYYYYYPPP.......',
    '.......RRYYYYYPPPP......',
    '......RRRYYYYPPPPP......',
    '.....BBOOOOOOOPPPP......',
    '....BBOO#OOOOOPPP.......',
    '....BBOO#OOOOORRBB......',
    '....BBOOOOOOOORRBB......',
    '....BBOOOOOOOORRBB......',
    '....BBOOOOOOOORRBB......',
    '....BBOOOOOORRRBB.......',
    '....BBOOOOORRRRBB.......',
    '....BBOOORRRRRBB........',
    '....BBBBBBBBBBBB........',
    '....BBBBBBBBBBBB........',
    '........................',
    '........................',
    '........................',
    '........................',
  ],
};

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

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [size, grid] of Object.entries(GRIDS)) {
  if (grid.length !== +size || grid.some((r) => r.length !== +size)) {
    throw new Error(size + 'px 网格尺寸不符');
  }
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = PALETTE[grid[y][x]];
      if (!c) throw new Error('未知字符: ' + grid[y][x]);
      rgba.set(c, (y * size + x) * 4);
    }
  }
  const fp = path.join(OUT, 'icon-' + size + '.png');
  fs.writeFileSync(fp, encodePng(+size, rgba));
  console.log('written', fp);
}
