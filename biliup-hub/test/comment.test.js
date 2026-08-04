// test/comment.test.js —— comment.js 单测
// 覆盖：评论发布拿到 rpid / 置顶返回 ok / 失败抛错（mock fetch）。
const test = require('node:test');
const assert = require('node:assert');
const comment = require('../lib/comment');

function fakeResp(obj) { return { json: async () => obj }; }

test('post: 返回 rpid', async () => {
  const fetchFn = async () => fakeResp({ code: 0, data: { rpid: 555 } });
  const rpid = await comment.post(1, '评论内容', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } });
  assert.strictEqual(rpid, 555);
});

test('post: 未返回 rpid 抛错', async () => {
  const fetchFn = async () => fakeResp({ code: 0, data: {} });
  await assert.rejects(
    async () => await comment.post(1, 'x', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /未返回 rpid/
  );
});

test('post: 失败码抛错', async () => {
  const fetchFn = async () => fakeResp({ code: -101, message: '未登录' });
  await assert.rejects(
    async () => await comment.post(1, 'x', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /未登录/
  );
});

test('pin: top 返回 ok', async () => {
  let urlSeen = '';
  let bodySeen = '';
  const fetchFn = async (url, opts) => { urlSeen = url; bodySeen = opts.body; return fakeResp({ code: 0, data: {} }); };
  const r = await comment.pin(1, 555, 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } });
  assert.strictEqual(r.ok, true);
  assert.ok(urlSeen.includes('/reply/top'), 'pin 应请求 top 接口');
  assert.ok(bodySeen.includes('action=1'), 'pin 应带 action=1（置顶）');
});

test('pin: top 非 0 码抛错 (如 12011)', async () => {
  const fetchFn = async () => fakeResp({ code: 12011, message: '不合法的赞或踩' });
  await assert.rejects(
    async () => await comment.pin(1, 555, 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /评论置顶失败/
  );
});

test('pin: -404（评论资源不存在/审核期）重试耗尽后抛错且信息明确（外部限制，非致命）', async () => {
  const fetchFn = async () => fakeResp({ code: -404, message: '啥都木有' });
  await assert.rejects(
    async () => await comment.pin(1, 555, 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /持续 -404.*重试 10 次仍失败/
  );
});

test('pin: -404 首次失败第二次成功 → 最终成功（审核期延迟窗口）', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) return fakeResp({ code: -404, message: '啥都木有' });
    return fakeResp({ code: 0, data: {} });
  };
  const r = await comment.pin(1, 555, 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } });
  assert.equal(r.ok, true);
  assert.equal(calls, 2, '第二次调用成功');
});

test('pin: fetch 网络错误抛错', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  await assert.rejects(
    async () => await comment.pin(1, 555, 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } }),
    /network down/
  );
});

test('post: 请求体含 oid/message/csrf', async () => {
  let bodySeen = '';
  const fetchFn = async (url, opts) => { bodySeen = opts.body; return fakeResp({ code: 0, data: { rpid: 9 } }); };
  await comment.post(42, 'hi', 'mycsrf', 'cookie', { deps: { fetchFn, sleep: async () => {} } });
  assert.ok(bodySeen.includes('oid=42'));
  assert.ok(bodySeen.includes('message=hi'));
  assert.ok(bodySeen.includes('csrf=mycsrf'));
});

test('pin: 请求体含 rpid 与 action=REPLY_SETTOP_ACTION', async () => {
  let urlSeen = '';
  let bodySeen = '';
  const fetchFn = async (url, opts) => { urlSeen = url; bodySeen = opts.body; return fakeResp({ code: 0 }); };
  await comment.pin(42, 9, 'mycsrf', 'cookie', { deps: { fetchFn, sleep: async () => {} } });
  assert.ok(urlSeen.includes('/reply/top'), 'pin 应请求 top 接口');
  assert.ok(bodySeen.includes('rpid=9'));
  assert.ok(bodySeen.includes('action=' + comment.REPLY_SETTOP_ACTION));
});

test('post: -404 首次失败第二次成功 → 最终成功返回 rpid（审核期延迟窗口）', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls === 1) return fakeResp({ code: -404, message: '啥都木有' });
    return fakeResp({ code: 0, data: { rpid: 777 } });
  };
  const rpid = await comment.post(1, 'msg', 'csrf', 'c', { deps: { fetchFn, sleep: async () => {} } });
  assert.equal(rpid, 777);
  assert.equal(calls, 2, '第二次调用成功');
});

test('post: 持续 -404 重试耗尽后抛错且带重试次数', async () => {
  const fetchFn = async () => fakeResp({ code: -404, message: '啥都木有' });
  await assert.rejects(
    async () => await comment.post(1, 'msg', 'csrf', 'c', {
      deps: { fetchFn, sleep: async () => {} },
    }),
    /持续 -404.*重试 10 次仍失败/
  );
});

test('withRetryOn404: 非 -404 错误码不重试，立即返回', async () => {
  let calls = 0;
  const r = await comment.withRetryOn404(async () => {
    calls += 1;
    return { code: -509, message: '请求过于频繁' };
  }, { deps: { sleep: async () => {} } });
  assert.equal(r.code, -509);
  assert.equal(calls, 1, '非 -404 不重试');
});
