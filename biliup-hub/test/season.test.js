// test/season.test.js —— season.js 单测
// 覆盖：合集添加成功 / -404 重试后成功 / 非 -404 立即失败 / 耗尽抛错（mock fetch）。
const test = require('node:test');
const assert = require('node:assert');
const season = require('../lib/season');

function fakeResp(obj) { return { json: async () => obj }; }

test('add: 成功返回 ok', async () => {
  const fetchFn = async () => fakeResp({ code: 0, data: {} });
  const r = await season.add('7630305', 1, 2, 't', 'csrf', 'SESSDATA=x', { deps: { fetchFn, sleep: async () => {} } });
  assert.strictEqual(r.ok, true);
});

test('add: -404 重试后成功（第 3 次）', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return calls < 3 ? fakeResp({ code: -404 }) : fakeResp({ code: 0 });
  };
  const r = await season.add('7630305', 1, 2, 't', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} }, onLog: () => {} });
  assert.strictEqual(calls, 3);
  assert.strictEqual(r.ok, true);
});

test('add: 非 -404 立即失败（不重试）', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return fakeResp({ code: -101, message: '未登录' }); };
  await assert.rejects(
    async () => await season.add('7630305', 1, 2, 't', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /未登录/
  );
  assert.strictEqual(calls, 1);
});

test('add: 始终 -404 耗尽抛错', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return fakeResp({ code: -404 }); };
  await assert.rejects(
    async () => await season.add('7630305', 1, 2, 't', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /重试耗尽/
  );
  assert.strictEqual(calls, 20);
});

test('add: 请求体含 sectionId + episodes(charging_pay:0)', async () => {
  let bodySeen = '';
  const fetchFn = async (url, opts) => { bodySeen = opts.body; return fakeResp({ code: 0 }); };
  await season.add('7630305', 11, 22, '标题', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } });
  assert.ok(bodySeen.includes('sectionId=7630305'), '应包含 sectionId');
  assert.ok(bodySeen.includes('csrf=csrf'));
  const m = bodySeen.match(/episodes=(.*)$/);
  assert.ok(m, '应包含 episodes');
  const ep = JSON.parse(decodeURIComponent(m[1]));
  assert.strictEqual(ep[0].aid, 11);
  assert.strictEqual(ep[0].cid, 22);
  assert.strictEqual(ep[0].title, '标题');
  assert.strictEqual(ep[0].charging_pay, 0);
});
