// test/biliup.test.js —— biliup.js 单测
// 覆盖：上传输出解析、getVideoInfo 重试 20×10s（mock child_process / fetch）。
const test = require('node:test');
const assert = require('node:assert');
const biliup = require('../lib/biliup');

test('parseUploadOutput: 从 stdout 解析 bvid/aid', () => {
  const out = 'uploading...\nBV1xxABC done\n{"aid":123456,"bvid":"BV1xxABC"}';
  const r = biliup.parseUploadOutput(out);
  assert.strictEqual(r.bvid, 'BV1xxABC');
  assert.strictEqual(r.aid, 123456);
});

test('parseUploadOutput: 仅 aid（无 bvid）也能解析', () => {
  const r = biliup.parseUploadOutput('aid=777 success');
  assert.strictEqual(r.aid, 777);
  assert.strictEqual(r.bvid, null);
});

test('runUpload: 调用 runViaTempScript 并解析', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async (script, opts) => {
      if (opts && opts.onLog) opts.onLog('progress 50%');
      return { stdout: 'BV1TEST123 aid=999', stderr: '' };
    },
  };
  const ref = await biliup.runUpload(fakeScript, { deps });
  assert.strictEqual(ref.bvid, 'BV1TEST123');
  assert.strictEqual(ref.aid, 999);
});

test('getVideoInfo: 立即成功', async () => {
  const fetchFn = async () => ({ json: async () => ({ code: 0, data: { aid: 1, cid: 2, title: 't' } }) });
  const vi = await biliup.getVideoInfo({ bvid: 'BVx' }, { deps: { fetchFn, sleep: async () => {} } });
  assert.deepStrictEqual(vi, { aid: 1, cid: 2, title: 't' });
});

test('getVideoInfo: -404 重试后成功（第 3 次）', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls < 3) return { json: async () => ({ code: -404 }) };
    return { json: async () => ({ code: 0, data: { aid: 10, cid: 20, title: 't' } }) };
  };
  const vi = await biliup.getVideoInfo({ aid: 10 }, { deps: { fetchFn, sleep: async () => {} }, onLog: () => {} });
  assert.strictEqual(calls, 3, '应在第 3 次成功');
  assert.strictEqual(vi.aid, 10);
});

test('getVideoInfo: 始终 -404 则重试耗尽抛错', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return { json: async () => ({ code: -404 }) }; };
  await assert.rejects(
    async () => await biliup.getVideoInfo({ bvid: 'BVx' }, { deps: { fetchFn, sleep: async () => {} } }),
    /重试耗尽/
  );
  assert.strictEqual(calls, 20, '应重试满 20 次');
});

test('getVideoInfo: 非 -404 错误码立即失败（不重试）', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return { json: async () => ({ code: -101, message: '未登录' }) }; };
  await assert.rejects(
    async () => await biliup.getVideoInfo({ bvid: 'BVx' }, { deps: { fetchFn, sleep: async () => {} } }),
    /未登录/
  );
  assert.strictEqual(calls, 1, '非 -404 应立即失败');
});
