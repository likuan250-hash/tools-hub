// store 持久化层补测：ensure 首次运行 + flushWrite 原子刷盘
// 注意：NODE test runner 对每个 .test.js 单独 spawn 子进程，环境变量隔离安全。
const os = require('os');
const fs = require('fs');
const path = require('path');

// 必须在 require store 之前设定（store 加载时固定 DATA_DIR / KEY_FILE）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'netdisk-flush-'));
process.env.NETDISK_DATA_DIR = path.join(TMP, 'data');
process.env.NETDISK_KEY_FILE = path.join(TMP, '.masterkey');

const store = require('../src/store');
const { test } = require('node:test');
const assert = require('node:assert');

const STORE_FILE = path.join(process.env.NETDISK_DATA_DIR, 'store.json');
const TMP_FILE = STORE_FILE + '.tmp';

test('ensure 首次运行：DATA_DIR/STORE_FILE 不存在时创建加密空结构', () => {
  assert.ok(!fs.existsSync(STORE_FILE), '前置：首次运行前 store 文件不应存在');
  const d = store.read(); // 触发 ensure
  assert.ok(fs.existsSync(STORE_FILE), 'ensure 应创建 STORE_FILE');
  assert.deepStrictEqual(d, { accounts: {}, tasks: [] }, '首次结构应为空');
  // 落盘内容可解密回空结构（验证是加密写入而非损坏）
  const blob = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  assert.deepStrictEqual(store.decryptObj(blob), { accounts: {}, tasks: [] });
});

test('flushWrite 原子刷盘：saveAccount 后同步落盘且无 .tmp 残留', () => {
  store.saveAccount('baidu', { cookie: 'BDUSS=x' });
  store.flushWrite(); // 直接同步刷盘（绕开异步写队列，便于断言）
  assert.ok(fs.existsSync(STORE_FILE), 'flushWrite 后应存在 store 文件');
  assert.ok(!fs.existsSync(TMP_FILE), '原子写应 rename 完成，无 .tmp 残留');
  const blob = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const back = store.decryptObj(blob);
  assert.strictEqual(back.accounts.baidu.cookie, 'BDUSS=x', '落盘内容应还原账户');
});

test('flushWrite 幂等：重复调用不产生 .tmp 且不损坏文件', () => {
  store.flushWrite();
  store.flushWrite();
  assert.ok(!fs.existsSync(TMP_FILE), '多次 flushWrite 后无 .tmp 残留');
  const blob = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  const back = store.decryptObj(blob);
  assert.strictEqual(back.accounts.baidu.cookie, 'BDUSS=x', '文件应保持一致');
});
