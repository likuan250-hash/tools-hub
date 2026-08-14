// scripts/verify-comic-skin-sync.js —— 门禁：六处 comic-skin 副本必须与 shared/ 真源逐字节一致。
// 与 verify-cosmic-skin-sync.js 同构，供 CI / npm test 防「手改单份副本」漂移。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COPIES = [
  'renderer',
  'netdisk-hub/public',
  'kdocs-tool/public',
  'biliup-hub/public',
  'material-hub/public',
  'resolve-hub/public',
];
const FILES = ['comic-skin.css', 'comic-skin.js'];

let bad = 0;
for (const f of FILES) {
  const src = path.join(ROOT, 'shared', 'comic-skin', f);
  const s = fs.readFileSync(src);
  for (const dir of COPIES) {
    const p = path.join(ROOT, dir, f);
    if (!fs.existsSync(p) || !fs.readFileSync(p).equals(s)) {
      console.error(`[FAIL] ${dir}/${f} 与 shared/comic-skin/${f} 不一致（请运行 npm run sync-comic-skin）`);
      bad += 1;
    }
  }
}
if (bad) {
  console.error(`comic-skin 同步门禁未通过：${bad} 处不一致。`);
  process.exit(1);
}
console.log('comic-skin 六处副本与真源一致。');
