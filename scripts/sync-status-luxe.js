// scripts/sync-status-luxe.js
//
// 单一来源工作流工具：把「真源」shared/status-luxe 的两份文件
// （status-luxe.css / status-luxe.js）复制到三处前端副本
// （renderer / netdisk-hub/public / kdocs-tool/public）。
//
// 设计原则（对应 verify-status-luxe-sync.js 的门禁）：
//   - 幂等：当三副本已与真源逐字节一致时，不做任何写入（no-op）。
//   - 不破坏手工编辑：若三副本彼此不一致（疑似有人只改了其中一份），
//     拒绝静默覆盖，报错退出(1)并提示先手工统一，避免误删某份的编辑。
//   - 仅显式调用时执行：本脚本不会挂到 prepare/构建钩子，需手动
//     `npm run sync-status-luxe`（开发者改完 shared/ 后主动同步）。
//
// 正常用法：
//   1) 编辑 shared/status-luxe/status-luxe.{css,js}
//   2) npm run sync-status-luxe   # 同步到三处前端
//   3) npm run verify:status-luxe # 可选，确认门禁仍绿
//
// 退出码：全部同步成功(含无变更) exit 0；检测到副本彼此分歧 exit 1。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED = { name: 'shared', dir: 'shared/status-luxe' };
const COPIES = [
  { name: 'renderer', dir: 'renderer' },
  { name: 'netdisk-hub', dir: 'netdisk-hub/public' },
  { name: 'kdocs-tool', dir: 'kdocs-tool/public' },
];
const FILES = ['status-luxe.css', 'status-luxe.js'];

function readFileOrNull(p) {
  try {
    return fs.readFileSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
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

  // 收集三副本中「存在」的内容，检测彼此分歧。
  const existing = COPIES.map((c) => {
    const p = path.join(ROOT, c.dir, f);
    const buf = readFileOrNull(p);
    return { c, p, buf };
  }).filter((e) => e.buf !== null);

  const distinct = new Set(existing.map((e) => e.buf.toString('utf8')));
  if (distinct.size > 1) {
    divergence = true;
    console.error(`[FAIL] ${f} 三副本彼此不一致（疑似手工编辑），拒绝覆盖。`);
    for (const e of existing) {
      console.error(`  - ${e.c.name}: ${e.p}`);
    }
    console.error(`  请先手工统一三副本，再运行本脚本（或先回灌 shared/ 后同步）。`);
    continue;
  }

  // 三副本一致（或仅缺失）：以真源覆盖/补齐，幂等。
  for (const c of COPIES) {
    const p = path.join(ROOT, c.dir, f);
    if (fs.existsSync(p) && fs.readFileSync(p).equals(sharedBuf)) {
      // 已一致，跳过写入（幂等，不触碰 mtime）。
      continue;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sharedBuf);
    changedAny = true;
    console.log(`[SYNC] ${f} → ${c.name} (${p})`);
  }
}

if (divergence) {
  process.exit(1);
}
if (changedAny) {
  console.log('\nstatus-luxe 已以 shared/ 为真源同步到三处前端副本。');
} else {
  console.log('\nstatus-luxe 三处前端副本已与真源一致，无需同步。');
}
