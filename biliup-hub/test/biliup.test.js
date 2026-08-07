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

test('parseUploadOutput: 兼容 biliup ResponseData 的 Number(...) aid 形态', () => {
  const out = 'ResponseData { code: 0, data: Some(Object {"aid": Number(117042187343755), "bvid": String("BV19LM16MExz")}) }';
  const r = biliup.parseUploadOutput(out);
  assert.strictEqual(r.bvid, 'BV19LM16MExz');
  assert.strictEqual(r.aid, 117042187343755);
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
  assert.strictEqual(calls, 120, '应重试满 120 次');
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

test('getVideoInfo: 62003（定时发布待发布）→ 立即失败且标记 scheduled，不重试', async () => {
  let calls = 0;
  const fetchFn = async () => { calls += 1; return { json: async () => ({ code: 62003, message: '稿件已审核通过，等待发布中' }) }; };
  let err = null;
  try {
    await biliup.getVideoInfo({ bvid: 'BVx' }, { deps: { fetchFn, sleep: async () => {} }, onLog: () => {} });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '应抛出错误');
  assert.equal(err.code, 62003);
  assert.equal(err.scheduled, true);
  assert.strictEqual(calls, 1, '62003 不应重试');
});

test('getVideoInfo: 指数退避间隔符合 5s/7s 且封顶 30s', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  // 前两次 -404 触发退避，第三次成功（仅消费前两次等待记录）。
  const fetchFn = async () => {
    calls += 1;
    if (calls < 3) return { json: async () => ({ code: -404 }) };
    return { json: async () => ({ code: 0, data: { aid: 1, cid: 2, title: 't' } }) };
  };
  await biliup.getVideoInfo({ bvid: 'BVx' }, { deps: { fetchFn, sleep }, onLog: () => {} });
  assert.strictEqual(waits.length, 2, '应等待 2 次后退避成功');
  assert.strictEqual(waits[0], 5000, '第 1 次等待应为 5s（BASE_INTERVAL）');
  assert.strictEqual(waits[1], 7000, '第 2 次等待应为 7s（5000×1.4）');
  for (const w of waits) {
    assert.ok(w <= 30000, '退避间隔不应超过封顶 30s，实际 ' + w);
  }
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

// ── 修复二：exit0 假成功但 stderr 暴露 B站 API 失败 → 主动暴露真实原因 ──
// 全程 mock runViaTempScript 与 fs（避免真删文件/真跑二进制）。
const noopFs = { mkdirSync: () => {}, writeFileSync: () => {} };

test('runUpload(修复二-A): exit=0 但 stderr 含 {"code":-400,"message":"请求错误"} → 抛 biliup 上传失败(code=-400)', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: '', stderr: 'Error: {"code":-400,"data":null,"message":"请求错误","ttl":1}', code: 0 }),
    fs: noopFs,
  };
  await assert.rejects(
    async () => await biliup.runUpload(fakeScript, { deps }),
    /biliup 上传失败\(code=-400\)/
  );
});

test('runUpload(修复二-B): exit=0 但 stderr 含 "token 失效" → 抛疑似鉴权/会话失效', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: '', stderr: 'token 失效，请重新登录', code: 0 }),
    fs: noopFs,
  };
  await assert.rejects(
    async () => await biliup.runUpload(fakeScript, { deps }),
    /biliup 上传失败\(疑似鉴权\/会话失效\)/
  );
});

test('runUpload(修复二-C 回归): exit=0 且 stderr 为空 → 仍返回空 ref（不抛错，保留旧行为）', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: '', stderr: '', code: 0 }),
    fs: noopFs,
  };
  const ref = await biliup.runUpload(fakeScript, { deps });
  assert.deepStrictEqual(ref, { bvid: null, aid: null });
});

// ── detectBiliupApiFailure 直接单测 ──
test('detectBiliupApiFailure: stderr 为空/纯空白 → 不抛错（返回 undefined）', () => {
  assert.strictEqual(biliup.detectBiliupApiFailure(''), undefined);
  assert.strictEqual(biliup.detectBiliupApiFailure('   '), undefined);
});

test('detectBiliupApiFailure: 含鉴权关键字但无 code JSON → 抛疑似鉴权/会话失效', () => {
  assert.throws(
    () => biliup.detectBiliupApiFailure('登录过期，请重新登录'),
    /biliup 上传失败\(疑似鉴权\/会话失效\)/
  );
});

test('detectBiliupApiFailure: 含负数 code JSON → 抛出 message 内容', () => {
  assert.throws(
    () => biliup.detectBiliupApiFailure('Error: {"code":-101,"message":"请先登录"}'),
    /biliup 上传失败\(code=-101\): 请先登录/
  );
});

// ── 补充断言（QA 严过关）：修复二-A 的抛出 message 必须与产品预期文案「逐字」一致，
// 避免下游被「缺少 bvid/aid」之类误导性文案掩盖。engineer 用例仅用正则匹配前缀，
// 此处用精确全等校验整句。 ──
test('runUpload(修复二-A 强化): exit=0 含 -400 JSON → 抛错 message 精确为「biliup 上传失败(code=-400): 请求错误」', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const deps = {
    runViaTempScript: async () => ({ stdout: '', stderr: 'Error: {"code":-400,"data":null,"message":"请求错误","ttl":1}', code: 0 }),
    fs: noopFs,
  };
  await assert.rejects(
    async () => await biliup.runUpload(fakeScript, { deps }),
    (err) => err instanceof Error && err.message === 'biliup 上传失败(code=-400): 请求错误',
    'message 应为精确文案，而非误导性「缺少 bvid/aid」'
  );
});

// ── 补充断言（QA 严过关）：模拟真实回放，stderr 为多行混合日志（含其它 biliup 噪声）
// 仍能从其中定位负数 code JSON 并抛出清晰错误，不被噪声淹没。 ──
test('runUpload(修复二-A 噪声行): stderr 含进度噪点 + -400 JSON → 仍精确抛出', async () => {
  const fakeScript = { content: 'x', shell: 'ps1' };
  const noisy = [
    '[INFO] preparing upload...',
    'some unrelated warning line',
    'Error: {"code":-400,"data":null,"message":"请求错误","ttl":1}',
    '[DEBUG] exit',
  ].join('\n');
  const deps = {
    runViaTempScript: async () => ({ stdout: '', stderr: noisy, code: 0 }),
    fs: noopFs,
  };
  await assert.rejects(
    async () => await biliup.runUpload(fakeScript, { deps }),
    (err) => err instanceof Error && err.message === 'biliup 上传失败(code=-400): 请求错误'
  );
});

// ── getCreativeArchive（archive/view：定时待发布也能取真实 cid）──
test('getCreativeArchive: 成功返回 aid/cid/title', async () => {
  const fetchFn = async (url) => {
    assert.ok(url.includes('/x/vupre/web/archive/view?bvid=BV1'), '应带 bvid 查询');
    return {
      json: async () => ({
        code: 0,
        data: {
          archive: { aid: 123, title: '标题' },
          videos: [{ cid: 456 }],
        },
      }),
    };
  };
  const info = await biliup.getCreativeArchive({ bvid: 'BV1' }, 'SESSDATA=x', { deps: { fetchFn } });
  assert.deepEqual(info, { aid: 123, cid: 456, title: '标题' });
});

test('getCreativeArchive: 非 0 码抛错', async () => {
  const fetchFn = async () => ({ json: async () => ({ code: -101, message: '未登录' }) });
  await assert.rejects(
    async () => await biliup.getCreativeArchive({ aid: 1 }, 'SESSDATA=x', { deps: { fetchFn } }),
    (err) => err instanceof Error && /archive\/view 返回 code=-101/.test(err.message)
  );
});

test('getCreativeArchive: 缺 bvid/aid 直接抛错', async () => {
  await assert.rejects(
    async () => await biliup.getCreativeArchive({}, 'SESSDATA=x', { deps: { fetchFn: async () => {} } }),
    (err) => err instanceof Error && /缺少 bvid\/aid/.test(err.message)
  );
});
