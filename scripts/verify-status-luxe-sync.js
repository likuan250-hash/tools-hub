// scripts/verify-status-luxe-sync.js
//
// 校验 status-luxe 的「单一事实来源」shared/status-luxe 与四处前端副本
// （renderer / netdisk-hub/public / kdocs-tool/public / biliup-hub/public）的 css 与 js
// 是否逐字节一致。任一副本与真源或彼此不一致则 exit(1) 并打印差异。
//
// 这样「真源」被纳入门禁：改了 shared/ 但忘了同步四副本 → CI 红灯；
// 改了某副本但忘了回灌 shared/ → 同样红灯。从流程上消除漂移隐患。
//
// 退出码：一致 exit 0；不一致 exit 1。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// 单一事实来源（真源）。作为比对基准。
const SHARED = { name: 'shared', dir: 'shared/status-luxe' };
// 四处前端副本。
const COPIES = [
  { name: 'renderer', dir: 'renderer' },
  { name: 'netdisk-hub', dir: 'netdisk-hub/public' },
  { name: 'kdocs-tool', dir: 'kdocs-tool/public' },
  { name: 'biliup-hub', dir: 'biliup-hub/public' },
];
// 参与比对的全部位置：真源在前，便于「副本须与真源一致」的语义。
const LOCATIONS = [SHARED, ...COPIES];
const FILES = ['status-luxe.css', 'status-luxe.js'];

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let failed = false;
for (const f of FILES) {
  const entries = LOCATIONS.map((c) => {
    const p = path.join(ROOT, c.dir, f);
    if (!fs.existsSync(p)) {
      console.error(`[FAIL] 缺失文件: ${p}`);
      failed = true;
      return null;
    }
    return { name: c.name, path: p, hash: sha256(p) };
  });
  const present = entries.filter(Boolean);
  if (present.length < LOCATIONS.length) { failed = true; continue; }

  // 以真源 shared 作为基准。
  const base = present[0];
  const mismatched = present.filter((h) => h.hash !== base.hash);
  if (mismatched.length) {
    failed = true;
    console.error(`[FAIL] ${f} 不一致（基准: ${base.name}):`);
    for (const h of present) {
      const mark = h.hash === base.hash ? 'OK ' : '!! ';
      console.error(`  ${mark}${h.name}: ${h.hash}  (${h.path})`);
    }
  } else {
    console.log(`[ OK ] ${f} 真源与四处前端副本一致 (${base.hash})`);
  }
}

if (failed) {
  console.error('\nstatus-luxe 同步校验未通过：真源 shared/status-luxe 与四处前端副本必须逐字节一致。');
  console.error('如需以 shared/ 为准同步四副本，运行: npm run sync-status-luxe');
  process.exit(1);
}
console.log('\nstatus-luxe 真源与四处前端副本全部逐字节一致。');
