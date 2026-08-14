// scripts/verify-cosmic-skin-sync.js —— CI 门禁：五处 cosmic-skin 副本必须与真源逐字节一致。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = 'shared/cosmic-skin';
const COPIES = ['renderer', 'netdisk-hub/public', 'kdocs-tool/public', 'biliup-hub/public', 'material-hub/public', 'resolve-hub/public'];
const FILES = ['cosmic-skin.css', 'cosmic-skin.js', 'ark-pixel-16px-latin.woff2', 'ark-pixel-16px-zh_cn.woff2', 'OFL-ark-pixel.txt'];

let fail = false;
for (const f of FILES) {
  const shared = fs.readFileSync(path.join(ROOT, SHARED, f));
  for (const c of COPIES) {
    const p = path.join(ROOT, c, f);
    if (!fs.existsSync(p) || !fs.readFileSync(p).equals(shared)) {
      fail = true;
      console.error(`[FAIL] ${f} 副本与真源不一致: ${p}（请运行 npm run sync-cosmic-skin）`);
    }
  }
}
if (fail) process.exit(1);
console.log('cosmic-skin 六处副本与真源逐字节一致。');
