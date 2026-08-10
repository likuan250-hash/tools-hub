// biliup-hub/test/server.test.js —— server.js 单测（H：/api/seasons 接口）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 准备临时数据目录（cookies 落点）；必须在 require('../server') 之前设定，
// 因为 store 在首次 getConfig 时惰性读取 BILIUP_DATA_DIR。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biliup-seasons-'));

function writeCookies(obj) {
  fs.writeFileSync(path.join(TMP, 'cookies.json'), JSON.stringify(obj), 'utf8');
}

process.env.BILIUP_DATA_DIR = TMP;
// 预置 config（seasonId=11），让 store 首次惰性读取时就带上合集，供 /api/season/detect 用例使用。
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  seasonId: '11',
  sectionId: '111',
  comment: 'c',
  desc: 'd',
  tags: [],
  tid: 17,
  copyright: 1,
  noReprint: 1,
  line: 'bda2',
  uid: 1,
  defaultTags: '',
  biliupExePath: '',
  ffmpegPath: '',
  cookiesPath: path.join(TMP, 'cookies.json'),
  loginInfoPath: path.join(TMP, 'login_info.json'),
}), 'utf8');

const app = require('../server');

// 默认注入一个不发起真实网络的「分集补拉」fetch stub，避免既有 /api/seasons 测试触发真实请求。
// 具体用例可在各自 test 内覆盖 app.locals.seasonSectionFetch。
app.locals.seasonSectionFetch = async () => ({
  ok: true,
  json: async () => ({ code: 0, data: { sections: [] } }),
});

function startServer() {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function getJSON(srv, p) {
  const port = srv.address().port;
  const resp = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: resp.status, body: await resp.json() };
}

test('GET /api/seasons 登录态：保留 state=0，过滤 state=-6，映射 sections', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        seasons: [
          // B站真实结构：分集在顶层 sections.sections（嵌套），season.sections 常为空。
          { season: { id: 11, title: '合集A', state: 0 }, sections: { sections: [{ id: 111, title: '分集1' }, { id: 112, title: '分集2' }] } },
          { season: { id: 22, title: '草稿合集', state: -6 }, sections: { sections: [{ id: 221, title: '分集X' }] } },
          { season: { id: 33, title: '合集B', state: 0 } },
        ],
      },
    }),
  });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      seasons: [
        {
          id: '11',
          title: '合集A',
          sections: [{ id: '111', title: '分集1' }, { id: '112', title: '分集2' }],
          no_section: false,
        },
        { id: '33', title: '合集B', sections: [], no_section: false },
      ],
    });
  } finally {
    app.locals.seasonsFetch = undefined;
    srv.close();
  }
});

test('GET /api/pending-pins：返回待置顶队列（初始为空）', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/pending-pins');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.list));
  } finally {
    srv.close();
  }
});

test('GET /api/events：SSE 事件流端点', async () => {
  const srv = await startServer();
  try {
    const port = srv.address().port;
    const resp = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(resp.status, 200);
    assert.ok((resp.headers.get('content-type') || '').includes('text/event-stream'));
    const reader = resp.body.getReader();
    await reader.cancel();
  } finally {
    srv.close();
  }
});

test('/api/pending-videos：增改查删 + 清理已完成', async () => {
  const srv = await startServer();
  try {
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    const post = (p, body) => fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    // 空名拒绝
    let r = await post('/api/pending-videos', { name: '  ' });
    assert.equal(r.status, 400);
    // 添加
    r = await post('/api/pending-videos', { name: '【游戏272】零.红蝶' });
    const added = await r.json();
    assert.equal(added.ok, true);
    const id = added.item.id;
    // 同名拒绝
    r = await post('/api/pending-videos', { name: '【游戏272】零.红蝶' });
    assert.equal(r.status, 400);
    // 勾选有资源 + 已发布
    r = await post('/api/pending-videos/' + id, { hasResource: true });
    assert.equal((await r.json()).ok, true);
    r = await post('/api/pending-videos/' + id, { published: true });
    assert.equal((await r.json()).ok, true);
    // 列表与清理
    let list = (await (await fetch(base + '/api/pending-videos')).json()).list;
    assert.equal(list.length, 1);
    assert.equal(list[0].hasResource && list[0].published, true);
    r = await post('/api/pending-videos/clear-done');
    assert.equal((await r.json()).removed, 1);
    list = (await (await fetch(base + '/api/pending-videos')).json()).list;
    assert.equal(list.length, 0);
    // 删除不存在记录幂等
    r = await fetch(base + '/api/pending-videos/' + id, { method: 'DELETE' });
    assert.equal(r.status, 200);
  } finally {
    srv.close();
  }
});

test('GET /api/seasons 未登录（cookies 无效）：降级 {seasons:[]}', async () => {
  writeCookies({}); // 缺少 SESSDATA / bili_jct
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, { seasons: [] });
  } finally {
    srv.close();
  }
});

test('GET /api/seasons 接口异常：降级 {seasons:[]}（不抛 500）', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => { throw new Error('network down'); };
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, { seasons: [] });
  } finally {
    app.locals.seasonsFetch = undefined;
    srv.close();
  }
});

// ── /api/season/detect：检测最近发布但未加入所选合集的稿件 ──
test('GET /api/season/detect：未入合集且晚于合集创建时间 → 列为候选', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });

  app.locals.seasonDetectFetch = async (url) => {
    const u = String(url);
    if (u.includes('/archives/sp')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            arc_audits: [
              { Archive: { aid: 1001, bvid: 'BV1AA', title: '新视频', state: 0 }, season_add_state: 0 },
              { Archive: { aid: 1002, bvid: 'BV1BB', title: '已入合集', state: 0 }, season_add_state: 2 },
            ],
          },
        }),
      };
    }
    if (u.includes('/seasons?')) {
      return {
        ok: true,
        json: async () => ({ code: 0, data: { seasons: [{ season: { id: 11, ctime: 1785000000 } }] } }),
      };
    }
    if (u.includes('/x/web-interface/view?bvid=BV1AA')) {
      return {
        ok: true,
        json: async () => ({ code: 0, data: { aid: 1001, cid: 555, pubdate: 1785900000, ugc_season: null, pages: [{ cid: 555 }] } }),
      };
    }
    return { ok: true, json: async () => ({ code: 0, data: { ugc_season: { id: 11 } } }) };
  };

  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/season/detect?limit=20');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.candidates.length, 1, '只有未入合集的稿件应列为候选');
    assert.equal(body.candidates[0].aid, 1001);
    assert.equal(body.candidates[0].cid, 555);
  } finally {
    app.locals.seasonDetectFetch = undefined;
    srv.close();
  }
});

test('GET /api/seasons 上游非 200：降级 {seasons:[]}', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({ ok: false, status: 412, json: async () => ({}) });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/seasons');
    assert.deepEqual(body, { seasons: [] });
  } finally {
    app.locals.seasonsFetch = undefined;
    srv.close();
  }
});

test('GET /api/seasons 上游缺 sections 时补拉 season/section 补充分集（需求①）', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        seasons: [
          // 上游未返回 sections，需补拉
          { season: { id: 44, title: '合集C', state: 0, sections: [] } },
        ],
      },
    }),
  });
  app.locals.seasonSectionFetch = async () => ({
    ok: true,
    json: async () => ({ code: 0, data: { sections: [{ id: 441, title: '分集甲' }, { id: 442, title: '分集乙' }] } }),
  });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      seasons: [
        {
          id: '44',
          title: '合集C',
          sections: [{ id: '441', title: '分集甲' }, { id: '442', title: '分集乙' }],
          no_section: false,
        },
      ],
    });
  } finally {
    app.locals.seasonsFetch = undefined;
    app.locals.seasonSectionFetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { sections: [] } }) });
    srv.close();
  }
});

test('GET /api/seasons 补拉分集接口异常：降级空 sections（不抛 500，需求①）', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: { seasons: [{ season: { id: 55, title: '合集D', state: 0, sections: [] } }] },
    }),
  });
  app.locals.seasonSectionFetch = async () => { throw new Error('network down'); };
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, { seasons: [{ id: '55', title: '合集D', sections: [], no_section: false }] });
  } finally {
    app.locals.seasonsFetch = undefined;
    app.locals.seasonSectionFetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { sections: [] } }) });
    srv.close();
  }
});

// ───────────────────────── /api/seasons no_section 标志（需求①根因） ─────────────────────────
test('GET /api/seasons 合集 no_section=1（真·无分集）：标记 no_section=true 且不补拉', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: { seasons: [{ season: { id: 66, title: '纯合集', state: 0, no_section: 1, sections: [] } }] },
    }),
  });
  // 补拉 stub 故意返回「假分集」：若代码误发起补拉，sections 会混入该假分集，
  // 故断言 sections:[] 即可证明 no_section=1 时确实未补拉（避免无意义的网络请求）。
  app.locals.seasonSectionFetch = async () => ({
    ok: true,
    json: async () => ({ code: 0, data: { sections: [{ id: 999, title: '不该出现' }] } }),
  });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      seasons: [{ id: '66', title: '纯合集', sections: [], no_section: true }],
    });
  } finally {
    app.locals.seasonsFetch = undefined;
    app.locals.seasonSectionFetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { sections: [] } }) });
    srv.close();
  }
});

test('GET /api/seasons 合集 no_section 字段缺失时默认 false（兼容上游未返回该字段）', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      // 上游未返回 no_section 字段，且未返回 sections（需补拉）
      data: { seasons: [{ season: { id: 77, title: '合集E', state: 0, sections: [] } }] },
    }),
  });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    // 补拉返回空 → sections:[]，且 no_section 默认 false（B站未声明无分集）
    assert.deepEqual(body, {
      seasons: [{ id: '77', title: '合集E', sections: [], no_section: false }],
    });
  } finally {
    app.locals.seasonsFetch = undefined;
    srv.close();
  }
});

// ───────────────────────── /api/seasons 嵌套 sections.sections（需求①回归实测） ─────────────────────────
// 实测（2026-08）：合集「绵绵不绝」no_section=1，但顶层 sections.sections 含默认「正片」分集。
// 旧实现只读 season.sections（为空）→ 前端分集下拉恒空 → sectionId 空 → task.js 跳过合集后置。
// 回归：必须从嵌套路径取分集（no_section 标志不可靠，不能据此跳过）。
test('GET /api/seasons no_section=1 但 sections.sections 含默认正片分集：正常返回分集', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  app.locals.seasonsFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        seasons: [
          {
            season: { id: 8700479, title: '绵绵不绝', state: 0, no_section: 1 },
            sections: { sections: [{ id: 9695491, title: '正片' }] },
          },
        ],
      },
    }),
  });
  // 补拉 stub 故意返回「假分集」：若代码误发起补拉会混入，断言即失败。
  app.locals.seasonSectionFetch = async () => ({
    ok: true,
    json: async () => ({ code: 0, data: { sections: [{ id: 999, title: '不该出现' }] } }),
  });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/seasons');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      seasons: [
        { id: '8700479', title: '绵绵不绝', sections: [{ id: '9695491', title: '正片' }], no_section: true },
      ],
    });
  } finally {
    app.locals.seasonsFetch = undefined;
    app.locals.seasonSectionFetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { sections: [] } }) });
    srv.close();
  }
});

// ───────────────────────── /api/tags/suggest（需求②修订） ─────────────────────────
// 不再调 B站官方 tag/recommend：推荐 = 标题提取游戏名 + 本地类型规则，前端合并固定默认标签。
test('GET /api/tags/suggest 正当防卫4：返回 游戏名 + 类型标签（动作/开放世界），无无关标签', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(
      srv,
      '/api/tags/suggest?keyword=' + encodeURIComponent('【游戏268】正当防卫4 官方中文+全DLC+免安装硬盘版 免费学习版下载.mp4'),
    );
    assert.equal(status, 200);
    assert.deepEqual(body, { tags: ['正当防卫4', '动作游戏', '开放世界'] });
  } finally {
    srv.close();
  }
});

test('GET /api/tags/suggest EA SPORTS FC 26：返回 游戏名 + 体育/足球类型', async () => {
  writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  const srv = await startServer();
  try {
    const { body } = await getJSON(
      srv,
      '/api/tags/suggest?keyword=' + encodeURIComponent('【游戏269】EA SPORTS FC 26 官方中文+全DLC+免安装硬盘版 免费学习版下载'),
    );
    assert.deepEqual(body, { tags: ['EA SPORTS FC 26', '体育游戏', '足球游戏'] });
  } finally {
    srv.close();
  }
});

test('GET /api/tags/suggest 规则表外游戏：只有游戏名（不混入无关标签）', async () => {
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=' + encodeURIComponent('【游戏999】某冷门独立游戏 官方中文版'));
    assert.deepEqual(body, { tags: ['某冷门独立游戏'] });
  } finally {
    srv.close();
  }
});

test('GET /api/tags/suggest 缺 keyword / 无有效游戏名：返回 {tags:[]}', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/tags/suggest');
    assert.equal(status, 200);
    assert.deepEqual(body, { tags: [] });
    const body2 = await getJSON(srv, '/api/tags/suggest?keyword=' + encodeURIComponent('第3期'));
    assert.deepEqual(body2.body, { tags: [] });
  } finally {
    srv.close();
  }
});

test('GET /api/tags/suggest 未登录也能推荐（本地提取，无网络依赖）', async () => {
  writeCookies({});
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=' + encodeURIComponent('正当防卫4 官方中文版'));
    assert.deepEqual(body, { tags: ['正当防卫4', '动作游戏', '开放世界'] });
  } finally {
    srv.close();
    writeCookies({ SESSDATA: 'x', bili_jct: 'y' });
  }
});

// ── extractGameName：从标题/文件名提取游戏名 ──
test('extractGameName：脏文件名清洗为游戏名（正当防卫4）', () => {
  assert.equal(
    app.extractGameName('【游戏268】正当防卫4 官方中文+全DLC+免安装硬盘版 免费学习版下载.mp4'),
    '正当防卫4',
  );
});

test('extractGameName：保留英文名数字与中文冒号（EA SPORTS FC 26 / 光环：战役进化）', () => {
  assert.equal(app.extractGameName('【游戏269】EA SPORTS FC 26 官方中文+全DLC+免安装硬盘版 免费学习版下载'), 'EA SPORTS FC 26');
  assert.equal(app.extractGameName('【游戏264】光环：战役进化 官方中文+高级版+免安装硬盘版 免费学习版下载'), '光环：战役进化');
});

test('extractGameName：剥尾部第N期/纯数字/空输入', () => {
  assert.equal(app.extractGameName('辐射4 实况 - 第1期.mp4'), '辐射4 实况');
  assert.equal(app.extractGameName('2024'), '');
  assert.equal(app.extractGameName('   '), '');
  assert.equal(app.extractGameName(''), '');
  assert.equal(app.extractGameName(undefined), '');
});

// ── matchGenreTags：本地类型规则 ──
test('matchGenreTags：正当防卫4 → 动作/开放世界（不含足球类）', () => {
  assert.deepEqual(app.matchGenreTags('正当防卫4'), ['动作游戏', '开放世界']);
});

test('matchGenreTags：EA SPORTS FC 26 → 体育/足球；光环 → 射击', () => {
  assert.deepEqual(app.matchGenreTags('EA SPORTS FC 26'), ['体育游戏', '足球游戏']);
  assert.deepEqual(app.matchGenreTags('光环：战役进化'), ['射击游戏']);
});

test('matchGenreTags：多规则命中跨规则去重（森林之子 → 生存+恐怖）', () => {
  const tags = app.matchGenreTags('森林之子');
  assert.ok(tags.includes('生存游戏'), '应含生存游戏: ' + JSON.stringify(tags));
  assert.ok(tags.includes('恐怖游戏'), '应含恐怖游戏: ' + JSON.stringify(tags));
});

test('matchGenreTags：规则表外返回空数组；空输入安全', () => {
  assert.deepEqual(app.matchGenreTags('某冷门独立游戏'), []);
  assert.deepEqual(app.matchGenreTags(''), []);
  assert.deepEqual(app.matchGenreTags(undefined), []);
});

