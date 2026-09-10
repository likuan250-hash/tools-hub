// scripts/sync-gameboy-skin.js
//
// 单一来源工作流工具：把「真源」shared/gameboy-skin 的文件
// （gameboy-skin.css / gameboy-skin.js / 像素字体）复制到六处前端副本
// （renderer / netdisk-hub/public / kdocs-tool/public / biliup-hub/public / material-hub/public / resolve-hub/public）。
//
// 设计原则（与 comic/cosmic 同步脚本一致，对应 verify-gameboy-skin-sync.js 门禁）：
//   - 幂等：六副本已与真源逐字节一致时不做任何写入。
//   - 不破坏手工编辑：六副本彼此不一致时拒绝静默覆盖，报错退出 1。
//   - 仅显式调用时执行：`npm run sync-gameboy-skin`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = { name: 'shared', dir: 'shared/gameboy-skin' };
const COPIES = [
  { name: 'renderer', dir: 'renderer' },
  { name: 'netdisk-hub', dir: 'netdisk-hub/public' },
  { name: 'kdocs-tool', dir: 'kdocs-tool/public' },
  { name: 'biliup-hub', dir: 'biliup-hub/public' },
  { name: 'material-hub', dir: 'material-hub/public' },
  { name: 'resolve-hub', dir: 'resolve-hub/public' },
];
const FILES = [
  'gameboy-skin.css',
  'gameboy-skin.js',
  'ark-pixel-16px-zh_cn.woff2',
  'ark-pixel-16px-latin.woff2',
  'OFL-ark-pixel.txt',
];

let divergence = false;
let changedAny = false;

for (const f of FILES) {
  const sharedPath = path.join(ROOT, SHARED.dir, f);
  if (!fs.existsSync(sharedPath)) {
    console.error(`[FAIL] 真源缺失: ${sharedPath}`);
    process.exit(1);
  }
  const sharedBuf = fs.readFileSync(sharedPath);
  const existing = COPIES.map((c) => {
    const p = path.join(ROOT, c.dir, f);
    return { c, p, buf: fs.existsSync(p) ? fs.readFileSync(p) : null };
  }).filter((e) => e.buf !== null);
  const distinct = new Set(existing.map((e) => e.buf.toString('utf8')));
  if (distinct.size > 1) {
    divergence = true;
    console.error(`[FAIL] ${f} 副本彼此不一致（疑似手工编辑），拒绝覆盖。`);
    for (const e of existing) console.error(`  - ${e.c.name}: ${e.p}`);
    continue;
  }
  for (const c of COPIES) {
    const p = path.join(ROOT, c.dir, f);
    if (fs.existsSync(p) && fs.readFileSync(p).equals(sharedBuf)) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sharedBuf);
    changedAny = true;
    console.log(`[SYNC] ${f} -> ${c.name} (${p})`);
  }
}

if (divergence) process.exit(1);
console.log(
  changedAny
    ? '\ngameboy-skin 已以 shared/ 为真源同步到六处前端副本。'
    : '\ngameboy-skin 六处前端副本已与真源一致，无需同步。',
);
