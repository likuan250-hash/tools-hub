// test/biliup.test.js —— biliup.js 单测
// 覆盖：上传输出解析、getVideoInfo 重试 20×10s（mock child_process / fetch）、
//       P03 低风险改进：exit code 透传 + 完整 stdout 落盘 + 上传真实性早报。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const biliup = require('../lib/biliup');
const command = require('../lib/command');

// 列出 .tmp 下所有 upload-*.log，返回 { path, content }[]（供落盘断言）。
function listUploadLogs() {
  const dir = command.TMP_DIR;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^upload-.*\.log$/.test(f))
    .map((f) => {
      const fp = path.join(dir, f);
      return { path: fp, content: fs.readFileSync(fp, 'utf8') };
    });
}

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

// ── P03 低风险改进新增用例 ──

test('runUpload(用例A): exit=0 无 BV 输出 → 返回空 ref 且完整 stdout 已落盘', async () => {
  const marker = '某无BV输出-' + Date.now();
  const before = listUploadLogs().map((x) => x.path);
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: marker, stderr: '', code: 0 }),
  };
  const ref = await biliup.runUpload(fakeScript, { deps });
  assert.deepStrictEqual(ref, { bvid: null, aid: null });
  // 断言本次运行新生成的 upload-*.log 含完整 stdout 文本（落盘生效）。
  const logs = listUploadLogs().filter((x) => !before.includes(x.path));
  assert.ok(logs.length > 0, '应生成 upload-*.log');
  assert.ok(
    logs.some((x) => x.content.includes(marker)),
    '落盘日志应含完整 stdout 文本: ' + marker
  );
  // 清理本次测试产物
  for (const x of logs) { try { fs.unlinkSync(x.path); } catch (_) {} }
});

test('runUpload(用例B): exit=1 报错 → 抛错且 message 含 上传失败(exit=1)', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: '', stderr: 'some error', code: 1 }),
  };
  await assert.rejects(
    async () => await biliup.runUpload(fakeScript, { deps }),
    /上传失败\(exit=1\)/
  );
});

test('runUpload(用例C 回归): exit=0 含 BV+aid → 正常返回解析结果', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: 'BV1xx aid=123', stderr: '', code: 0 }),
  };
  const ref = await biliup.runUpload(fakeScript, { deps });
  assert.deepStrictEqual(ref, { bvid: 'BV1xx', aid: 123 });
});
