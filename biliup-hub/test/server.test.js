// test/server.test.js —— server.js /api/avatar 路由单测（mock fetch，不触网）
// 覆盖：入参校验（缺 face / 非法 scheme → 400）、上游代理成功透传 content-type、
// 上游非 2xx → 502、代理异常 → 500、路由存在性。
// 同源校验由 server.js 全局 origin 中间件负责，本测试请求不带 Origin 头，正常放行。
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// 让 server.js 的 startServer 绑定到随机端口，避免占用 3600 造成测试进程退出。
process.env.BILIUP_PORT = '0';
const app = require('../server');

function startTestServer() {
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function get(srv, pathname) {
  return new Promise((resolve, reject) => {
    const { port } = srv.address();
    const r = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    r.on('error', reject);
    r.end();
  });
}

function fakeImgResp({ ok = true, status = 200, ct = 'image/png', body = 'FAKEPNG' } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ct : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

// 非法 face 校验分支（不依赖 mock）。
test('GET /api/avatar: 缺 face → 400', async () => {
  const srv = await startTestServer();
  try {
    const r = await get(srv, '/api/avatar');
    assert.strictEqual(r.status, 400);
  } finally { srv.close(); }
});

test('GET /api/avatar: face 非 http(s)（javascript:） → 400', async () => {
  const srv = await startTestServer();
  try {
    const r = await get(srv, '/api/avatar?face=' + encodeURIComponent('javascript:alert(1)'));
    assert.strictEqual(r.status, 400);
  } finally { srv.close(); }
});

test('GET /api/avatar: face 非 http(s)（ftp:） → 400', async () => {
  const srv = await startTestServer();
  try {
    const r = await get(srv, '/api/avatar?face=' + encodeURIComponent('ftp://x.com/a.png'));
    assert.strictEqual(r.status, 400);
  } finally { srv.close(); }
});

// 以下用例需注入 mock fetch（写入 app.locals.avatarFetch），串行执行避免互相覆盖。
test.describe('GET /api/avatar: 代理分支（mock fetch）', { concurrency: 1 }, () => {
  test('合法 face + 上游 200 → 200 且透传 content-type + 二进制体 + 缓存头', async () => {
    app.locals.avatarFetch = async () => fakeImgResp({ ok: true, ct: 'image/png' });
    const srv = await startTestServer();
    try {
      const r = await get(srv, '/api/avatar?face=' + encodeURIComponent('https://i0.hdslb.com/avatar.png'));
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'] || '', /image\/png/);
      assert.strictEqual(r.body.toString(), 'FAKEPNG');
      assert.ok((r.headers['cache-control'] || '').includes('max-age=300'), '应带 Cache-Control: max-age=300');
    } finally { srv.close(); app.locals.avatarFetch = undefined; }
  });

  test('上游非 2xx → 502', async () => {
    app.locals.avatarFetch = async () => fakeImgResp({ ok: false, status: 404 });
    const srv = await startTestServer();
    try {
      const r = await get(srv, '/api/avatar?face=' + encodeURIComponent('https://i0.hdslb.com/x.png'));
      assert.strictEqual(r.status, 502);
    } finally { srv.close(); app.locals.avatarFetch = undefined; }
  });

  test('代理异常 → 500', async () => {
    app.locals.avatarFetch = async () => { throw new Error('boom'); };
    const srv = await startTestServer();
    try {
      const r = await get(srv, '/api/avatar?face=' + encodeURIComponent('https://i0.hdslb.com/x.png'));
      assert.strictEqual(r.status, 500);
    } finally { srv.close(); app.locals.avatarFetch = undefined; }
  });
});
