// biliup-hub/test/task.test.js —— task.run 状态机单测
// 全程通过 ctx.deps 注入 lib 模块 mock（auth/biliup/cover/season/comment/cookies/biliupBin/command），
// 不真连 B站、不真调 biliup 二进制、不真抽封面。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const task = require('../lib/task');
const { autoSelectSection } = require('../public/season-align');

// 建一个真实存在的「视频文件」（仅过 fs.existsSync 检查；extract 已被 mock）。
function makeVideoFile() {
  const p = path.join(os.tmpdir(), 'biliup_task_video_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.mp4');
  fs.writeFileSync(p, 'fake');
  return p;
}

// 基础 mock 工厂：upload 首次成功（无 -400），其余模块全部兜底 mock。
function baseMocks() {
  return {
    auth: {
      ensureLoginInfo: async () => {},
      loadLoginInfo: () => ({ token_info: { access_token: 'OLD', refresh_token: 'RT' } }),
      refreshToken: async () => ({ token_info: { access_token: 'NEW' } }),
    },
    biliup: {
      runUpload: async () => ({ bvid: 'BV1', aid: 1 }),
      getVideoInfo: async () => ({ aid: 1, cid: 100 }),
    },
    cover: {
      resolveFfmpeg: () => '/fake/ffmpeg',
      extract: async () => null,
    },
    command: {
      buildPs1: () => 'SCRIPT',
    },
    season: {
      add: async () => {},
    },
    comment: {
      post: async () => 999,
      pin: async () => {},
    },
    cookies: {
      validate: () => true,
      getCsrf: () => 'csrf',
      toHeader: () => 'Cookie: x',
    },
    biliupBin: {
      resolveBiliupBin: () => '/fake/biliup',
    },
  };
}

function makeCtx(deps, sectionId = '7630305') {
  return {
    config: {
      sectionId,
      comment: '测试评论',
      desc: 'desc',
      tags: [],
      loginInfoPath: path.join(os.tmpdir(), 'biliup_li_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json'),
      cookiesPath: path.join(os.tmpdir(), 'biliup_cookies_' + Date.now() + '.json'),
    },
    cookiesFile: { SESSDATA: 'x', bili_jct: 'y' },
    onEvent: () => {},
    deps,
  };
}

// ── 用例1：-400 鉴权失败 → refreshToken 成功 → 重试一次成功 ──
test('task.run: 上传首次 -400 → refreshToken 刷新成功后重试成功（ok:true, refreshToken 被调用, 不走 ensureLoginInfo 退路）', async () => {
  const video = makeVideoFile();
  const calls = { runUpload: 0, refreshToken: 0, ensureLoginInfo: 0, ensureFallback: 0 };
  const deps = baseMocks();
  deps.auth.ensureLoginInfo = async (wc, o) => {
    calls.ensureLoginInfo++;
    if (o && o.deps) calls.ensureFallback++; // 仅退路调用会带 deps
  };
  deps.auth.refreshToken = async () => { calls.refreshToken++; return { token_info: { access_token: 'NEW' } }; };
  deps.biliup.runUpload = async () => {
    calls.runUpload++;
    if (calls.runUpload === 1) {
      throw new Error('biliup 上传失败(code=-400): 请求错误');
    }
    return { bvid: 'BV1', aid: 1 };
  };

  const ctx = makeCtx(deps);
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true, '应投稿成功');
  assert.equal(result.bvid, 'BV1');
  assert.equal(result.aid, 1);
  assert.equal(calls.runUpload, 2, '应重试一次，共 2 次上传');
  assert.equal(calls.refreshToken, 1, 'refreshToken 应被调用一次');
  assert.equal(calls.ensureFallback, 0, '刷新成功时不应走 ensureLoginInfo 退路');
});

// ── 用例2：-400 → refreshToken 返回 null（refresh_token 也失效）→ ensureLoginInfo 退路重试成功 ──
test('task.run: 上传 -400 且 refreshToken 失败 → ensureLoginInfo 退路重试成功', async () => {
  const video = makeVideoFile();
  const calls = { runUpload: 0, refreshToken: 0, ensureFallback: 0 };
  const deps = baseMocks();
  deps.auth.ensureLoginInfo = async (wc, o) => {
    if (o && o.deps) calls.ensureFallback++;
  };
  deps.auth.refreshToken = async () => { calls.refreshToken++; return null; };
  deps.biliup.runUpload = async () => {
    calls.runUpload++;
    if (calls.runUpload === 1) {
      throw new Error('biliup 上传失败(code=-400): 请求错误');
    }
    return { bvid: 'BV1', aid: 1 };
  };

  const ctx = makeCtx(deps);
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true, '应投稿成功');
  assert.equal(calls.runUpload, 2, '应重试一次，共 2 次上传');
  assert.equal(calls.refreshToken, 1, 'refreshToken 应被调用一次');
  assert.equal(calls.ensureFallback, 1, 'refresh_token 失效时应走 ensureLoginInfo 退路');
});

// ── 用例3：非 -400 的上传错误不重试，直接向上抛 → ok:false ──
test('task.run: 非 -400 的上传错误不重试（仅 1 次上传，ok:false）', async () => {
  const video = makeVideoFile();
  const calls = { runUpload: 0, refreshToken: 0 };
  const deps = baseMocks();
  deps.auth.refreshToken = async () => { calls.refreshToken++; return null; };
  deps.biliup.runUpload = async () => {
    calls.runUpload++;
    throw new Error('biliup 上传失败(code=-412): 稿件不存在');
  };

  const ctx = makeCtx(deps);
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, false, '非 -400 应判失败');
  assert.equal(calls.runUpload, 1, '非 -400 不应重试');
  assert.equal(calls.refreshToken, 0, '非 -400 不应触发刷新');
});

// ── 用例4：season 标志真实反映（有 sectionId → true）──
test('task.run: 有 sectionId → done 事件与返回值 season===true', async () => {
  const video = makeVideoFile();
  let doneEvent = null;
  const deps = baseMocks();
  const ctx = makeCtx(deps, '7630305');
  ctx.onEvent = (ev) => { if (ev.type === 'done') doneEvent = ev; };

  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true);
  assert.ok(doneEvent, '应发出 done 事件');
  assert.equal(doneEvent.data.season, true, '有分集时 season 应为 true');
  assert.equal(result.season, true);
});

// ── 用例5：season 标志真实反映（无 sectionId → false）──
test('task.run: 无 sectionId → done 事件与返回值 season===false', async () => {
  const video = makeVideoFile();
  let doneEvent = null;
  const deps = baseMocks();
  const ctx = makeCtx(deps, '');
  ctx.onEvent = (ev) => { if (ev.type === 'done') doneEvent = ev; };

  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true);
  assert.ok(doneEvent, '应发出 done 事件');
  assert.equal(doneEvent.data.season, false, '无分集时 season 应为 false');
  assert.equal(result.season, false);
});

// ── 用例6：-400 且 loadLoginInfo 返回 null（无可读登录态）→ 跳过 refreshToken 直接走 ensureLoginInfo 退路重试成功 ──
// 覆盖 task.js 自愈中 loadLoginInfo 读取失败（文件缺失/损坏）的分支：此时无法 refresh_token，
// 应直接退路 ensureLoginInfo 用 web cookie 重换 token 并重试一次。
test('task.run: 上传 -400 且 loadLoginInfo 无可读文件 → 跳过 refreshToken 直接走 ensureLoginInfo 退路重试', async () => {
  const video = makeVideoFile();
  const calls = { runUpload: 0, refreshToken: 0, ensureFallback: 0 };
  const deps = baseMocks();
  deps.auth.loadLoginInfo = () => null; // 模拟登录态文件缺失/损坏
  deps.auth.refreshToken = async () => { calls.refreshToken++; return null; };
  deps.auth.ensureLoginInfo = async (wc, o) => {
    if (o && o.deps) calls.ensureFallback++; // 仅退路调用会带 deps
  };
  deps.biliup.runUpload = async () => {
    calls.runUpload++;
    if (calls.runUpload === 1) {
      throw new Error('biliup 上传失败(code=-400): 请求错误');
    }
    return { bvid: 'BV1', aid: 1 };
  };

  const ctx = makeCtx(deps);
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true, '应投稿成功');
  assert.equal(calls.runUpload, 2, '应重试一次，共 2 次上传');
  assert.equal(calls.refreshToken, 0, '无可读登录态时不应调用 refreshToken');
  assert.equal(calls.ensureFallback, 1, '应直接走 ensureLoginInfo 退路');
});

// ── 用例7（#问题1 修复）：合集仅单分集 → 字段对齐后 sectionId 存在 → season.add 被调用 ──
// 还原真实断链：用户只填「合集」(seasonId) 未填「分集」(sectionId)，
// 前端字段对齐在单分集合集时自动选中分集 → config.sectionId 非空 → task.js 触发 season.add。
test('task.run: 合集仅单分集经字段对齐 → sectionId 存在 → season.add 被调用', async () => {
  const video = makeVideoFile();
  // 模拟前端：用户选了合集 seasonId='123'，其仅有 1 个分集 id='456'。
  const seasonSections = { '123': [{ id: '456', title: '唯一分集' }] };
  const alignedSectionId = autoSelectSection(seasonSections['123']);
  assert.equal(alignedSectionId, '456', '单分集应自动对齐到 sectionId');

  let seasonAddCalled = false;
  const deps = baseMocks();
  deps.season.add = async () => { seasonAddCalled = true; };
  const ctx = makeCtx(deps, alignedSectionId);
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true);
  assert.equal(seasonAddCalled, true, '字段对齐后 season.add 应被调用（合集不再被跳过）');
  assert.equal(result.season, true, 'season 标志应为 true');
});
