// scripts/sync-cosmic-skin.js
//
// 单一来源工作流工具：把「真源」shared/cosmic-skin 的两份文件
// （cosmic-skin.css / cosmic-skin.js）复制到五处前端副本
// （renderer / netdisk-hub/public / kdocs-tool/public / biliup-hub/public / material-hub/public）。
//
// 设计原则（对应 verify-cosmic-skin-sync.js 的门禁）：
//   - 幂等：当五副本已与真源逐字节一致时，不做任何写入（no-op）。
//   - 不破坏手工编辑：若五副本彼此不一致（疑似有人只改了其中一份），
//     拒绝静默覆盖，报错退出(1)并提示先手工统一，避免误删某份的编辑。
//   - 仅显式调用时执行：需手动 `npm run sync-cosmic-skin`。
//
// 退出码：全部同步成功(含无变更) exit 0；检测到副本彼此分歧 exit 1。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = { name: 'shared', dir: 'shared/cosmic-skin' };
const COPIES = [
  { name: 'renderer', dir: 'renderer' },
  { name: 'netdisk-hub', dir: 'netdisk-hub/public' },
  { name: 'kdocs-tool', dir: 'kdocs-tool/public' },
  { name: 'biliup-hub', dir: 'biliup-hub/public' },
  { name: 'material-hub', dir: 'material-hub/public' },
  { name: 'resolve-hub', dir: 'resolve-hub/public' },
];
const FILES = ['cosmic-skin.css', 'cosmic-skin.js', 'ark-pixel-16px-latin.woff2', 'ark-pixel-16px-zh_cn.woff2', 'OFL-ark-pixel.txt'];

function readFileOrNull(p) {
  try { return fs.readFileSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

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
    return { c, p, buf: readFileOrNull(p) };
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
    console.log(`[SYNC] ${f} → ${c.name} (${p})`);
  }
}

if (divergence) process.exit(1);
console.log(changedAny ? '\ncosmic-skin 已以 shared/ 为真源同步到六处前端副本。' : '\ncosmic-skin 六处前端副本已与真源一致，无需同步。');
