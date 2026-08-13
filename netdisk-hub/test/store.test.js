// netdisk-hub 持久化层测试：加密往返 / 篡改检测 / 账户与任务读写 / 失败任务清理
// 注意：NODE 的 test runner 对每个 .test.js 单独 spawn 子进程，故此处环境变量隔离安全。
const os = require('os');
const fs = require('fs');
const path = require('path');

// 必须在 require store 之前设定，store 在加载时即固定 DATA_DIR / KEY_FILE / MAX_TASKS。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'netdisk-store-'));
process.env.NETDISK_DATA_DIR = path.join(TMP, 'data');
process.env.NETDISK_KEY_FILE = path.join(TMP, '.masterkey');
process.env.MAX_TASKS = '5'; // 截断测试用

const store = require('../src/store');
const { test } = require('node:test');
const assert = require('node:assert');

test('encryptObj/decryptObj 往返一致（密文非明文）', () => {
  const obj = { accounts: { baidu: { cookie: 'BDUSS=abc' } }, tasks: [{ id: '1', status: 'done' }] };
  const blob = store.encryptObj(obj);
  assert.notDeepStrictEqual(JSON.stringify(blob), JSON.stringify(obj));
  assert.ok(blob.v === 1 && blob.d && blob.t && blob.k);
  const back = store.decryptObj(blob);
  assert.deepStrictEqual(back, obj);
});

test('decryptObj 篡改密文抛错（GCM 认证失败）', () => {
  const blob = store.encryptObj({ a: 1 });
  // 末位 hex 翻转，必然破坏密文完整性
  const last = blob.d.slice(-2);
  blob.d = blob.d.slice(0, -2) + (last === '00' ? 'ff' : '00');
  assert.throws(() => store.decryptObj(blob));
});

test('decryptObj 篡改 auth tag 抛错', () => {
  const blob = store.encryptObj({ a: 1 });
  const last = blob.t.slice(-2);
  blob.t = blob.t.slice(0, -2) + (last === '00' ? 'ff' : '00');
  assert.throws(() => store.decryptObj(blob));
});

test('saveAccount/getAccount 往返一致且注入 updatedAt', () => {
  store.write({ accounts: {}, tasks: [] });
  const saved = store.saveAccount('baidu', { cookie: 'BDUSS=x' });
  assert.strictEqual(saved.cookie, 'BDUSS=x');
  assert.ok(saved.updatedAt);
  const got = store.getAccount('baidu');
  assert.strictEqual(got.cookie, 'BDUSS=x');
  assert.strictEqual(store.getAccount('quark'), null);
});

test('addTask 按 unshift 顺序入队且受 MAX_TASKS 截断', () => {
  store.write({ accounts: {}, tasks: [] });
  for (let i = 0; i < 10; i++) store.addTask({ name: 't' + i, status: 'done' });
  const tasks = store.getTasks();
  assert.strictEqual(tasks.length, 5);
  assert.strictEqual(tasks[0].name, 't9'); // 最后加入的排在最前
  assert.strictEqual(tasks[4].name, 't5');
});

test('backupAndRemoveFailed 移除 failed 任务并落盘 trash', () => {
  store.write({ accounts: {}, tasks: [] });
  store.addTask({ name: 'ok', status: 'done' });
  store.addTask({ name: 'bad1', status: 'failed' });
  store.addTask({ name: 'bad2', status: 'failed' });

  const res = store.backupAndRemoveFailed();
  assert.strictEqual(res.removed, 2);

  const tasks = store.getTasks();
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].name, 'ok');

  // failed 任务已备份到 store-trash-*.json
  const trashFiles = fs.readdirSync(process.env.NETDISK_DATA_DIR).filter((n) => /^store-trash-/.test(n));
  assert.ok(trashFiles.length >= 1);
  const blob = JSON.parse(fs.readFileSync(path.join(process.env.NETDISK_DATA_DIR, trashFiles[0]), 'utf8'));
  const trash = store.decryptObj(blob);
  assert.ok(trash.failed && trash.failed.length === 2, 'encrypted trash holds failed records');
  assert.ok(trash.failed.every((t) => t.status === 'failed'));
});

test('updateTask updates record in place', () => {
  store.write({ accounts: {}, tasks: [] });
  const t = store.addTask({ name: 'x', status: 'failed', error: 'boom' });
  const up = store.updateTask(t.id, { status: 'success', error: null, shareLink: 'http://x' });
  assert.ok(up);
  assert.strictEqual(up.status, 'success');
  assert.strictEqual(up.error, null);
  assert.strictEqual(up.shareLink, 'http://x');
  assert.strictEqual(store.updateTask('nope', { status: 'success' }), null);
});
