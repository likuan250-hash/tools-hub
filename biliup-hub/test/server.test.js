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
        { id: '11', title: '合集A', sections: [{ id: '111', title: '分集1' }, { id: '112', title: '分集2' }] },
        { id: '33', title: '合集B', sections: [] },
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
