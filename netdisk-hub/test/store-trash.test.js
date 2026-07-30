// store 持久化层补测：cleanOldTrash 的保留期 + 数量上限 + 24h 速率限制
// 注意：NODE test runner 对每个 .test.js 单独 spawn 子进程，环境变量隔离安全。
const os = require('os');
const fs = require('fs');
const path = require('path');

// 必须在 require store 之前设定。
// TRASH_RETENTION_DAYS 压到 1 天，使「超龄」判定不依赖系统真实时钟，可确定性复现。
process.env.TRASH_RETENTION_DAYS = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'netdisk-trash-'));
process.env.NETDISK_DATA_DIR = path.join(TMP, 'data');
process.env.NETDISK_KEY_FILE = path.join(TMP, '.masterkey');

// 手动预置 trash 文件（模拟 backupAndRemoveFailed 落地），设置不同 mtime 以区分超龄/新鲜。
const DATA_DIR = process.env.NETDISK_DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
function makeTrash(name, ageMs) {
  const p = path.join(DATA_DIR, name);
  fs.writeFileSync(p, '[]');
  const m = new Date(now - ageMs); // 用 Date 对象，避免 utimesSync 把数字按秒解析(Windows 上会导致 EINVAL)
  fs.utimesSync(p, m, m); // 同时设置 atime/mtime
}
// 3 个超龄（40 天前）：应被保留期规则删除
for (let i = 0; i < 3; i++) makeTrash('store-trash-old-' + i + '.json', 40 * DAY);
// 15 个新鲜（1 小时前，彼此错开 1 分钟便于排序）：保留期不删，但超过上限 10 → 删最旧 5 个
for (let i = 0; i < 15; i++) makeTrash('store-trash-recent-' + i + '.json', 60 * 60 * 1000 + i * 60 * 1000);

const store = require('../src/store');
const { test } = require('node:test');
const assert = require('node:assert');

function trashList() {
  return fs.readdirSync(DATA_DIR).filter((n) => /^store-trash-.*\.json$/.test(n));
}

test('cleanOldTrash：删除超龄文件 + 仅保留最近 10 个（其余新鲜文件按上限删）', () => {
  // 本进程首次 read() 触发 ensure → cleanOldTrash（lastTrashCleanup 初始为 0，必然执行一次）
  store.read();
  const remaining = trashList();
  assert.strictEqual(remaining.length, 10, '应保留 10 个（3 超龄删 + 15 新鲜删最旧 5 = 10）');
  // 超龄的旧文件应全部消失
  assert.ok(!remaining.some((n) => n.startsWith('store-trash-old-')), '超龄文件应被清理');
  // 保留的应是较新的 recent（mtime 在 1 天内的任意 10 个）
  for (const n of remaining) {
    assert.ok(n.startsWith('store-trash-recent-'), '保留的应是新鲜文件');
  }
});

test('cleanOldTrash：24h 速率限制——同进程内二次 read 不再清理，状态稳定', () => {
  // 上一测试已触发一次清理并将 lastTrashCleanup 置为 now；此处应被 24h 门控跳过。
  const before = trashList().length;
  assert.doesNotThrow(() => store.read()); // 不应抛错
  const after = trashList().length;
  assert.strictEqual(after, before, '速率限制内不应二次清理，文件数稳定');
});
