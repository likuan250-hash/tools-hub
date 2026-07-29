const fs = require('fs');
const path = require('path');

// 数据目录：优先用工具箱注入的 NETDISK_DATA_DIR(指向 userData 真实目录，升级不丢)；
// 独立运行时回退到安装目录下的 data/。❌ 不再用 junction(NSIS 升级会误删)。
const DATA_DIR = process.env.NETDISK_DATA_DIR
  ? path.resolve(process.env.NETDISK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// 历史硬上限:仅保留最近 N 条,防止 store.json 无限膨胀。
const MAX_TASKS = Number(process.env.MAX_TASKS) || 1000;
const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS) || 30;
let lastTrashCleanup = 0;

// ── 内存缓存 + 串行写队列 ──
// 首次 read() 从文件加载到内存，之后全内存操作。
// 写操作通过 Promise 链排队刷盘，彻底杜绝并发竞态。
let cache = null;
let writeQueue = Promise.resolve();
let writeScheduled = false;

function cleanOldTrash() {
  const now = Date.now();
  if (now - lastTrashCleanup < 24 * 60 * 60 * 1000) return;
  lastTrashCleanup = now;
  try {
    const maxAge = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!/^store-trash-.*\.json$/.test(name)) continue;
      const file = path.join(DATA_DIR, name);
      if (now - fs.statSync(file).mtimeMs > maxAge) fs.unlinkSync(file);
    }
  } catch (e) { /* 清理失败不影响读写 */ }
}

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ accounts: {}, tasks: [] }, null, 2));
  }
  if (!cache) {
    cache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  }
  cleanOldTrash();
}

function read() {
  ensure();
  return cache;
}

// 原子刷盘：tmp + rename
function flushWrite() {
  if (!cache) return;
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

// 串行写队列：多次调用合并为一次刷盘
function scheduleWrite() {
  if (writeScheduled) return;
  writeScheduled = true;
  writeQueue = writeQueue.then(() => {
    writeScheduled = false;
    try { flushWrite(); }
    catch (e) { try { console.error('[store] write failed:', e.message); } catch (_) {} }
  });
}

// 保留旧 write() 签名兼容（改为走 cache）
function write(data) {
  cache = data;
  scheduleWrite();
}

function getAccount(provider) {
  const d = read();
  return d.accounts[provider] || null;
}

function saveAccount(provider, info) {
  const d = read();
  d.accounts[provider] = {
    ...(d.accounts[provider] || {}),
    ...info,
    updatedAt: new Date().toISOString(),
  };
  scheduleWrite();
  return d.accounts[provider];
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getDir(provider) {
  const d = read();
  return (d.dirs && d.dirs[provider]) || null;
}

function setDir(provider, info) {
  const d = read();
  d.dirs = d.dirs || {};
  d.dirs[provider] = { type: provider, name: info.name, id: info.id };
  scheduleWrite();
  return d.dirs[provider];
}

function addTask(task) {
  const d = read();
  const record = { id: genId(), createdAt: new Date().toISOString(), ...task };
  d.tasks.unshift(record);
  if (d.tasks.length > MAX_TASKS) d.tasks.length = MAX_TASKS;
  scheduleWrite();
  return record;
}

function backupAndRemoveFailed() {
  const d = read();
  const failed = d.tasks.filter((t) => t.status === 'failed');
  if (failed.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashFile = path.join(DATA_DIR, 'store-trash-' + stamp + '.json');
    try { fs.writeFileSync(trashFile, JSON.stringify(failed, null, 2)); } catch (e) {}
  }
  const before = d.tasks.length;
  d.tasks = d.tasks.filter((t) => t.status !== 'failed');
  scheduleWrite();
  return { removed: before - d.tasks.length, failed };
}

function getTasks() {
  const d = read();
  return d.tasks || [];
}

module.exports = { getAccount, saveAccount, addTask, getTasks, getDir, setDir, read, write, flushWrite, backupAndRemoveFailed };



