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

const app = require('../server');

// 默认注入一个不发起真实网络的「分集补拉」fetch stub，避免既有 /api/seasons 测试触发真实请求。
// 具体用例可在各自 test 内覆盖 app.locals.seasonSectionFetch。
app.locals.seasonSectionFetch = async () => ({
  ok: true,
  json: async () => ({ code: 0, data: { sections: [] } }),
});

// 默认注入一个不发起真实网络的「标签推荐」fetch stub，避免 /api/tags/suggest 测试触发真实请求。
// 具体用例可在各自 test 内覆盖 app.locals.tagSuggestFetch。
app.locals.tagSuggestFetch = async () => ({
  ok: true,
  json: async () => ({ code: 0, data: { tag: [] } }),
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
          { season: { id: 11, title: '合集A', state: 0, sections: [{ id: 111, title: '分集1' }, { id: 112, title: '分集2' }] } },
          { season: { id: 22, title: '草稿合集', state: -6, sections: [] } },
          { season: { id: 33, title: '合集B', state: 0, sections: [] } },
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

// ───────────────────────── /api/tags/suggest（需求②） ─────────────────────────
test('GET /api/tags/suggest 正常：解析 data.tag[].tag_name，取前 N=5 个', async () => {
  app.locals.tagSuggestFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: {
        tag: [
          { tag_name: '单机游戏' }, { tag_name: 'RPG' }, { tag_name: '开放世界' },
          { tag_name: '游戏实况' }, { tag_name: '攻略' }, { tag_name: '多余标签' },
        ],
      },
    }),
  });
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/tags/suggest?keyword=' + encodeURIComponent('辐射4'));
    assert.equal(status, 200);
    assert.deepEqual(body, { tags: ['单机游戏', 'RPG', '开放世界', '游戏实况', '攻略'] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 兼容 data.tags[].tag_name', async () => {
  app.locals.tagSuggestFetch = async () => ({
    ok: true,
    json: async () => ({ code: 0, data: { tags: [{ tag_name: '烹饪' }, { tag_name: '美食' }] } }),
  });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: ['烹饪', '美食'] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 兼容 data 直接为数组 data[].tag_name', async () => {
  app.locals.tagSuggestFetch = async () => ({
    ok: true,
    json: async () => ({ code: 0, data: [{ tag_name: 'A' }, { tag_name: 'B' }] }),
  });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: ['A', 'B'] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 深层嵌套也能提取（data.x.list[].tag_name）', async () => {
  app.locals.tagSuggestFetch = async () => ({
    ok: true,
    json: async () => ({ code: 0, data: { result: { list: [{ tag_name: '嵌套A' }, { tag_name: '嵌套B' }] } } }),
  });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: ['嵌套A', '嵌套B'] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 过滤黑名单/无意义标签（广告/bilibili 等）', async () => {
  app.locals.tagSuggestFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: { tag: [{ tag_name: '广告' }, { tag_name: 'bilibili' }, { tag_name: '实况' }, { tag_name: '攻略' }] },
    }),
  });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: ['实况', '攻略'] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 过滤敏感词（学习版/破解版 子串，与前端 genTags 一致）', async () => {
  app.locals.tagSuggestFetch = async () => ({
    ok: true,
    json: async () => ({
      code: 0,
      data: { tag: [{ tag_name: '正当防卫4' }, { tag_name: '免费学习版下载' }, { tag_name: '全DLC' }, { tag_name: '破解版' }] },
    }),
  });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: ['正当防卫4', '全DLC'] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest fetch 抛异常：降级 {tags:[]}（不抛 500）', async () => {
  app.locals.tagSuggestFetch = async () => { throw new Error('network down'); };
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.equal(status, 200);
    assert.deepEqual(body, { tags: [] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 上游非 200：降级 {tags:[]}（不抛 500）', async () => {
  app.locals.tagSuggestFetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: [] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 上游 JSON 解析失败：降级 {tags:[]}（不抛 500）', async () => {
  app.locals.tagSuggestFetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  const srv = await startServer();
  try {
    const { body } = await getJSON(srv, '/api/tags/suggest?keyword=x');
    assert.deepEqual(body, { tags: [] });
  } finally {
    app.locals.tagSuggestFetch = undefined;
    srv.close();
  }
});

test('GET /api/tags/suggest 缺 keyword：返回 {tags:[]}', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await getJSON(srv, '/api/tags/suggest');
    assert.equal(status, 200);
    assert.deepEqual(body, { tags: [] });
  } finally {
    srv.close();
  }
});
