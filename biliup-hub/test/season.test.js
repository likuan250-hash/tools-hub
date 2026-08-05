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

test('add: 官方 JSON 格式（URL 带 t/csrf，body 为 sectionId+episodes+csrf）', async () => {
  let urlSeen = '';
  let bodySeen = '';
  let headersSeen = null;
  const fetchFn = async (url, opts) => {
    urlSeen = url;
    bodySeen = opts.body;
    headersSeen = opts.headers;
    return fakeResp({ code: 0 });
  };
  await season.add('7630305', 11, 22, '标题', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } });
  assert.match(
    urlSeen,
    /^https:\/\/member\.bilibili\.com\/x2\/creative\/web\/season\/section\/episodes\/add\?t=\d+&csrf=csrf$/
  );
  assert.strictEqual(headersSeen['Content-Type'], 'application/json');
  const parsed = JSON.parse(bodySeen);
  assert.strictEqual(parsed.sectionId, 7630305);
  assert.strictEqual(parsed.csrf, 'csrf');
  assert.deepStrictEqual(parsed.episodes, [{ aid: 11, cid: 22, title: '标题' }]);
});

// ── resolveFirstSectionId：按合集解析首个分集（存量配置 seasonId→sectionId 兜底）──
test('resolveFirstSectionId: 优先取顶层 sections.sections（嵌套）首个分集（绵绵不绝 实测形态）', async () => {
  const fetchFn = async () => fakeResp({
    code: 0,
    data: {
      seasons: [
        { season: { id: 8700479, title: '绵绵不绝', no_section: 1 }, sections: { sections: [{ id: 9695491, title: '正片' }] } },
      ],
    },
  });
  const id = await season.resolveFirstSectionId('8700479', 'c', { deps: { fetchFn } });
  assert.strictEqual(id, '9695491');
});

test('resolveFirstSectionId: 顶层无分集时回退 season.sections', async () => {
  const fetchFn = async () => fakeResp({
    code: 0,
    data: { seasons: [{ season: { id: 1, title: 'A', sections: [{ id: 222, title: '分集' }] } }] },
  });
  const id = await season.resolveFirstSectionId('1', 'c', { deps: { fetchFn } });
  assert.strictEqual(id, '222');
});

test('resolveFirstSectionId: 两处均无分集返回 null', async () => {
  const fetchFn = async () => fakeResp({ code: 0, data: { seasons: [{ season: { id: 1, title: 'A' } }] } });
  const id = await season.resolveFirstSectionId('1', 'c', { deps: { fetchFn } });
  assert.strictEqual(id, null);
});

test('resolveFirstSectionId: 未命中 / code!=0 / 非 200 / 网络错误 均返回 null', async () => {
  const notFound = await season.resolveFirstSectionId('999', 'c', {
    deps: { fetchFn: async () => fakeResp({ code: 0, data: { seasons: [] } }) },
  });
  assert.strictEqual(notFound, null);
  const badCode = await season.resolveFirstSectionId('1', 'c', {
    deps: { fetchFn: async () => fakeResp({ code: -101, message: '未登录' }) },
  });
  assert.strictEqual(badCode, null);
  const notOk = await season.resolveFirstSectionId('1', 'c', {
    deps: { fetchFn: async () => ({ ok: false, json: async () => ({}) }) },
  });
  assert.strictEqual(notOk, null);
  const netErr = await season.resolveFirstSectionId('1', 'c', {
    deps: { fetchFn: async () => { throw new Error('boom'); } },
  });
  assert.strictEqual(netErr, null);
});
