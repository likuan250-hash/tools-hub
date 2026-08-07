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
      ensureFreshLoginInfo: async () => {},
      loadLoginInfo: () => ({ token_info: { access_token: 'OLD', refresh_token: 'RT' } }),
      refreshToken: async () => ({ token_info: { access_token: 'NEW' } }),
      // 加密登录态 → 临时明文文件（task.run 上传前调用，finally 中 cleanup）
      materializeLoginInfo: () => ({
        path: path.join(os.tmpdir(), 'biliup_li_materialized_' + Date.now() + '.json'),
        cleanup: () => {},
      }),
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
      resolveFirstSectionId: async () => null,
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

// ── 用例8（本 Bug 修复）：上传前 ensureFreshLoginInfo 临期触发 refreshToken（治本 -400，避免事后重试）──
// 用真实 auth 模块（确保 ensureFreshLoginInfo 实际行为），注入 mock fetchFn 模拟 refresh 成功。
// 验证：临期 token 在上传前被主动刷新写盘、不重换 TV、投稿成功（runUpload 仅 1 次，无 -400 自愈）。
test('task.run: 上传前 ensureFreshLoginInfo 临期主动 refresh（不重换 TV、投稿成功、无 -400 自愈）', async () => {
  const video = makeVideoFile();
  const liPath = path.join(os.tmpdir(), 'biliup_li_prerefresh_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json');
  const now = Math.floor(Date.now() / 1000);
  // 预先写入一个「已过期/临期」的 token（token_created_at 很久以前）。
  fs.writeFileSync(liPath, JSON.stringify({
    cookie_info: { cookies: [{ name: 'SESSDATA', value: 'v' }] },
    token_info: { access_token: 'OLD_AT', refresh_token: 'OLD_RT', expires_in: 3600, token_created_at: now - 3600 },
    sso: ['SESSDATA=v'],
  }));

  let refreshHit = false;
  let exchangeHit = false;
  const deps = baseMocks();
  deps.auth = require('../lib/auth'); // 用真实 auth 模块验证 ensureFreshLoginInfo 真实行为
  // 注入 fetchFn：refresh_token 端点成功；passport-tv-login（TV 换取）不应被调用。
  deps.fetchFn = async (url) => {
    const u = String(url);
    if (u.includes('/api/v2/oauth2/refresh_token')) {
      refreshHit = true;
      return { json: async () => ({ code: 0, data: { token_info: { access_token: 'REFRESHED_AT', refresh_token: 'NEWRT', expires_in: 3600 * 24 * 30 } } }) };
    }
    if (u.includes('passport-tv-login')) { exchangeHit = true; }
    return { json: async () => ({ code: -1 }) };
  };

  const ctx = makeCtx(deps);
  ctx.config.loginInfoPath = liPath; // 让 task 指向我们的临时登录态文件
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true, '临期刷新成功后应投稿成功');
  assert.equal(refreshHit, true, '临期应触发 refreshToken');
  assert.equal(exchangeHit, false, 'refresh 成功不应再走 TV 换取');
  // 验证写盘已刷新为最新 token（saveLoginInfo 加密落盘，需走 loadLoginInfo 读取）。
  const written = require('../lib/auth').loadLoginInfo(liPath);
  assert.equal(written.token_info.access_token, 'REFRESHED_AT', '登录态文件应被刷新为新 token');
  assert.ok(written.token_info.token_created_at > 0, '刷新后 token_created_at 应更新');
  fs.unlinkSync(liPath);
});

// ── 用例9（失败明确化）：web cookie 无效 + 无可用 token → 上传前抛清晰错误「登录态失效,请重新扫码」 ──
test('task.run: 登录态彻底失效（空 token + 无效 cookie）→ 上传前抛清晰错误,不静默传空 token', async () => {
  const video = makeVideoFile();
  const liPath = path.join(os.tmpdir(), 'biliup_li_dead_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.json');
  // 预先写入兜底空 token（access_token 为空）。
  fs.writeFileSync(liPath, JSON.stringify({
    cookie_info: { cookies: [] },
    token_info: { access_token: '', refresh_token: '', expires_in: 0, token_created_at: 0 },
    sso: [],
  }));

  const deps = baseMocks();
  deps.auth = require('../lib/auth'); // 用真实 auth 模块
  // web cookie 无效（无 SESSDATA/bili_jct）→ exchange 短路；refresh 无 refresh_token 跳过；最终无有效 token。
  deps.fetchFn = async () => ({ json: async () => ({ code: -1 }) });

  const ctx = makeCtx(deps);
  ctx.cookiesFile = {}; // 无效 web cookie
  ctx.config.loginInfoPath = liPath;
  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);
  fs.unlinkSync(liPath);

  assert.equal(result.ok, false, '登录态失效应判失败');
  assert.ok(/登录态失效/.test(result.error || '') && /扫码/.test(result.error || ''),
    '错误信息应直白指出登录态失效请重新扫码, 实际: ' + result.error);
  assert.ok(!result.stage, '失败应发生在投稿前(尚未进入具体 stage)');
});

// ── 用例10（需求③：合集后置失败降级为非致命）──
// 注入 season.add 抛错（模拟 B站合集接口返回非 0 码），验证：
//   1) runTask 不抛、不进入 error，仍走到 done 且 ok:true；
//   2) 日志含「合集后置失败（非致命」提示（便于真机贴日志定位根因）；
//   3) 后续评论置顶仍执行（season 失败不应阻断 commenting/done）。
test('task.run: 合集后置失败（非致命）→ 不阻断投稿，仍 done 且 ok:true，日志含非致命提示', async () => {
  const video = makeVideoFile();
  let doneEvent = null;
  const logs = [];
  const deps = baseMocks();
  deps.season.add = async () => {
    throw new Error('合集添加失败: code=11002 msg=合集不存在或状态异常');
  };
  const ctx = makeCtx(deps, '7630305');
  ctx.onEvent = (ev) => {
    if (ev.type === 'log') logs.push(ev.message);
    if (ev.type === 'done') doneEvent = ev;
  };

  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true, '合集失败不应阻断投稿（应为 ok:true）');
  assert.ok(doneEvent, '应正常发出 done 事件（未因合集失败而中断）');
  assert.ok(
    logs.some((m) => /合集后置失败（非致命/.test(m)),
    '日志应含非致命提示，实际日志: ' + JSON.stringify(logs)
  );
  // season 语义保持：仍反映「执行了合集后置尝试」（不改为成功与否）
  assert.equal(result.season, true, 'season 仍应反映曾尝试合集后置（保持原语义）');
  // 评论置顶阶段未受合集失败影响（baseMocks 中 comment 成功）
  assert.ok(logs.some((m) => /评论已发布并置顶/.test(m)), '评论置顶应在合集失败后继续执行');
});

// ── 用例11（需求①回归实测）：存量配置只有 seasonId（sectionId 为空）→ 上传时自动解析首个分集后置 ──
// 实测背景：升级前 /api/seasons 读错分集字段（应为顶层 sections.sections），用户配置只存了
// seasonId=8700479、sectionId='' → 合集后置被跳过。现在 task 侧兜底：按合集解析首个分集并调用 add。
test('task.run: seasonId 有、sectionId 空 → 自动解析首个分集 → season.add 被调用且 season=true', async () => {
  const video = makeVideoFile();
  let addSectionId = null;
  const deps = baseMocks();
  deps.season.resolveFirstSectionId = async () => '9695491';
  deps.season.add = async (sectionId) => { addSectionId = sectionId; };
  const ctx = makeCtx(deps, '');
  ctx.config.seasonId = '8700479';

  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true);
  assert.equal(addSectionId, '9695491', '应自动解析分集并调用 season.add');
  assert.equal(result.season, true, 'season 标志应为 true');
});

// ── 用例12：seasonId 有但解析不到分集 → 维持跳过语义（season=false，不抛错）──
test('task.run: seasonId 有、解析分集失败 → 跳过合集后置（season=false, ok:true）', async () => {
  const video = makeVideoFile();
  const deps = baseMocks();
  deps.season.resolveFirstSectionId = async () => null;
  const ctx = makeCtx(deps, '');
  ctx.config.seasonId = '8700479';

  const result = await task.run({ videoPath: video }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true);
  assert.equal(result.season, false, '解析不到分集时应维持跳过语义');
});

// ── 标题 UTF-8 字节截断（B站 APP 接口 80 字节限长，中文 1 字=3 字节）──
test('truncateTitleUtf8: 短标题原样返回', () => {
  const t = '【游戏272】零.红蝶.重制版';
  assert.equal(task.truncateTitleUtf8(t), t);
});

test('truncateTitleUtf8: 39 个中文字（99 字节）截到 ≤80 字节且不切断字符', () => {
  const t = '【游戏272】零.红蝶.重制版 官方中文+豪华版+免安装硬盘版 免费学习版下载';
  const out = task.truncateTitleUtf8(t);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 80, '截断后字节数应 ≤80');
  assert.ok(t.startsWith(out.split('…')[0]), '截断结果应保留原标题头部（游戏名）');
  assert.ok(t.endsWith(out.split('…').pop()), '截断结果应保留原标题尾部（免费学习版下载）');
  assert.ok(out.includes('…'), '超长标题应带省略号');
  assert.ok(!out.includes('�'), '不应出现半个字符');
});

test('truncateTitleUtf8: 恰 80 字节不截断；emoji（4 字节）不切断', () => {
  const t80 = '【游戏272】零.红蝶.重制版 官方中文+豪华版+免安装硬盘版'; // <80 字节
  const pad = 'a'.repeat(80 - Buffer.byteLength(t80, 'utf8'));
  const exact = t80 + pad;
  assert.equal(Buffer.byteLength(exact, 'utf8'), 80);
  assert.equal(task.truncateTitleUtf8(exact), exact);

  const emoji = '【游戏】🎮 免费学习版下载';
  const out = task.truncateTitleUtf8(emoji, 6);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 6, 'emoji 截断后仍 ≤ 上限');
  assert.ok(!out.includes('�'), '不应出现半个字符');
});

test('truncateTitleUtf8: 空/空白/null 返回空串', () => {
  assert.equal(task.truncateTitleUtf8(''), '');
  assert.equal(task.truncateTitleUtf8('   '), '');
  assert.equal(task.truncateTitleUtf8(null), '');
  assert.equal(task.truncateTitleUtf8(undefined), '');
});

test('task.run: 超长标题提交前被截断（command.buildPs1 收到截断后标题）', async () => {
  const video = makeVideoFile();
  const deps = baseMocks();
  let sentTitle = '';
  deps.command.buildPs1 = (req) => { sentTitle = req.title; return 'SCRIPT'; };
  const longTitle = '【游戏272】零.红蝶.重制版 官方中文+豪华版+免安装硬盘版 免费学习版下载'; // 99 字节
  const ctx = makeCtx(deps);
  const result = await task.run({ videoPath: video, title: longTitle }, ctx);
  fs.unlinkSync(video);

  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(sentTitle, 'utf8') <= 80, '提交给 biliup 的标题应 ≤80 字节');
  assert.ok(sentTitle.includes('…'), '超长标题应被截短且带省略号');
  assert.ok(longTitle.endsWith('免费学习版下载') && sentTitle.endsWith('免费学习版下载'), '应保留尾部关键信息');
});
