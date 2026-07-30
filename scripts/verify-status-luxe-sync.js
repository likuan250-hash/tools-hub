// scripts/verify-status-luxe-sync.js
// 校验三处 status-luxe 副本（renderer / netdisk-hub/public / kdocs-tool/public）
// 的 css 与 js 是否逐字节一致，不一致则 exit(1) 并打印差异。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const COPIES = [
  { name: 'renderer', dir: 'renderer' },
  { name: 'netdisk-hub', dir: 'netdisk-hub/public' },
  { name: 'kdocs-tool', dir: 'kdocs-tool/public' },
];
const FILES = ['status-luxe.css', 'status-luxe.js'];

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let failed = false;
for (const f of FILES) {
  const entries = COPIES.map((c) => {
    const p = path.join(ROOT, c.dir, f);
    if (!fs.existsSync(p)) {
      console.error(`[FAIL] 缺失文件: ${p}`);
      failed = true;
      return null;
    }
    return { name: c.name, path: p, hash: sha256(p) };
  });
  const present = entries.filter(Boolean);
  if (present.length < COPIES.length) { failed = true; continue; }

  const first = present[0];
  const mismatched = present.filter((h) => h.hash !== first.hash);
  if (mismatched.length) {
    failed = true;
    console.error(`[FAIL] ${f} 三处副本不一致:`);
    for (const h of present) {
      const mark = h.hash === first.hash ? 'OK ' : '!! ';
      console.error(`  ${mark}${h.name}: ${h.hash}  (${h.path})`);
    }
  } else {
    console.log(`[ OK ] ${f} 三处一致 (${first.hash})`);
  }
}

if (failed) {
  console.error('\nstatus-luxe 副本同步校验未通过，请检查三处文件是否逐字节一致。');
  process.exit(1);
}
console.log('\nstatus-luxe 三处副本全部逐字节一致。');
