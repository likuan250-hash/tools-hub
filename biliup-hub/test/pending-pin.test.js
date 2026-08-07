// lib/pendingPin.js —— 待置顶队列单测（临时文件，不落真实数据目录）
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pendingPin = require('../lib/pendingPin');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-pendingpin-'));
const FILE = path.join(TMP, 'pending_pins.json');
const COOKIES = path.join(TMP, 'cookies.json');
fs.writeFileSync(COOKIES, JSON.stringify({ SESSDATA: 'x', bili_jct: 'y' }), 'utf8');

const viewOk = { json: async () => ({ code: 0 }) };
const viewNotPub = { json: async () => ({ code: -404 }) };

test('add/remove/list：落盘与去重', () => {
  pendingPin.add({ aid: 1, bvid: 'BV1', rpid: 10 }, { file: FILE });
  pendingPin.add({ aid: 1, bvid: 'BV1', rpid: 11 }, { file: FILE }); // 同 aid 覆盖
  assert.strictEqual(pendingPin.list({ file: FILE }).length, 1);
  assert.strictEqual(pendingPin.list({ file: FILE })[0].rpid, 11);
  pendingPin.remove(1, { file: FILE });
  assert.strictEqual(pendingPin.list({ file: FILE }).length, 0);
});

test('processPending：稿件未公开 → 保留待下轮', async () => {
  pendingPin.add({ aid: 2, bvid: 'BV2', rpid: 20 }, { file: FILE });
  const r = await pendingPin.processPending({
    file: FILE, cookiesPath: COOKIES,
    fetchFn: async () => viewNotPub,
    pin: async () => ({ ok: true }),
  });
  assert.strictEqual(r.processed, 0);
  assert.strictEqual(r.pending, 1);
  pendingPin.remove(2, { file: FILE });
});

test('processPending：已公开且置顶成功 → 移除并回调', async () => {
  pendingPin.add({ aid: 3, bvid: 'BV3', rpid: 30 }, { file: FILE });
  let doneJob = null;
  let pinCalled = false;
  const r = await pendingPin.processPending({
    file: FILE, cookiesPath: COOKIES,
    fetchFn: async () => viewOk,
    pin: async (aid, rpid, csrf, cookieHeader) => { pinCalled = true; return { ok: true }; },
    onDone: (job) => { doneJob = job; },
  });
  assert.strictEqual(r.processed, 1);
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(pinCalled, true);
  assert.ok(doneJob && doneJob.aid === 3);
});

test('processPending：置顶失败 → 记录 lastError 并保留', async () => {
  pendingPin.add({ aid: 4, bvid: 'BV4', rpid: 40 }, { file: FILE });
  const r = await pendingPin.processPending({
    file: FILE, cookiesPath: COOKIES,
    fetchFn: async () => viewOk,
    pin: async () => { throw new Error('评论置顶失败: code=-101 msg=未登录'); },
  });
  assert.strictEqual(r.processed, 0);
  const jobs = pendingPin.list({ file: FILE });
  assert.strictEqual(jobs.length, 1);
  assert.ok(/未登录/.test(jobs[0].lastError), '应记录 lastError');
  assert.strictEqual(jobs[0].attempts, 1);
  pendingPin.remove(4, { file: FILE });
});

test('processPending：登录态缺失 → 跳过且不置顶', async () => {
  pendingPin.add({ aid: 5, bvid: 'BV5', rpid: 50 }, { file: FILE });
  const r = await pendingPin.processPending({
    file: FILE, cookiesPath: path.join(TMP, 'missing-cookies.json'),
    fetchFn: async () => viewOk,
    pin: async () => { throw new Error('不应调用'); },
  });
  assert.strictEqual(r.processed, 0);
  assert.strictEqual(r.pending, 1);
  pendingPin.remove(5, { file: FILE });
});

test('processPending：混合场景（A 成功移除、B 失败保留）→ A 不复活', async () => {
  pendingPin.add({ aid: 6, bvid: 'BV6', rpid: 60 }, { file: FILE });
  pendingPin.add({ aid: 7, bvid: 'BV7', rpid: 70 }, { file: FILE });
  const r = await pendingPin.processPending({
    file: FILE, cookiesPath: COOKIES,
    fetchFn: async () => viewOk,
    pin: async (aid) => {
      if (aid === 6) return { ok: true };
      throw new Error('评论置顶失败: code=-101 msg=未登录');
    },
  });
  assert.strictEqual(r.processed, 1);
  const jobs = pendingPin.list({ file: FILE });
  assert.strictEqual(jobs.length, 1, '成功任务不应被失败任务的保存复活');
  assert.strictEqual(jobs[0].aid, 7);
  pendingPin.remove(7, { file: FILE });
});
