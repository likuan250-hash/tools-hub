// scripts/sync-comic-skin.js
//
// 单一来源工作流工具：把「真源」shared/comic-skin 的两份文件
// （comic-skin.css / comic-skin.js）复制到六处前端副本
// （renderer / netdisk-hub/public / kdocs-tool/public / biliup-hub/public / material-hub/public / resolve-hub/public）。
//
// 设计原则（对应 verify-comic-skin-sync.js 的门禁）：
//   - 幂等：当六副本已与真源逐字节一致时，不做任何写入（no-op）。
//   - 不破坏手工编辑：若六副本彼此不一致（疑似有人只改了其中一份），
//     拒绝静默覆盖，报错退出 1 并提示先手工统一，避免误删某份的编辑。
//   - 仅显式调用时执行：需手动 `npm run sync-comic-skin`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = { name: 'shared', dir: 'shared/comic-skin' };
const COPIES = [
  { name: 'renderer', dir: 'renderer' },
  { name: 'netdisk-hub', dir: 'netdisk-hub/public' },
  { name: 'kdocs-tool', dir: 'kdocs-tool/public' },
  { name: 'biliup-hub', dir: 'biliup-hub/public' },
  { name: 'material-hub', dir: 'material-hub/public' },
  { name: 'resolve-hub', dir: 'resolve-hub/public' },
];
const FILES = ['comic-skin.css', 'comic-skin.js'];

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
console.log(changedAny ? '\ncomic-skin 已以 shared/ 为真源同步到六处前端副本。' : '\ncomic-skin 六处前端副本已与真源一致，无需同步。');
