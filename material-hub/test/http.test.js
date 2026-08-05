// test/http.test.js —— 代理感知 HTTP 工具单测（缺陷 2）
// 只测纯函数层：代理 URL 解析 / 环境变量挑选 / NO_PROXY 匹配 / 请求头合并 / 代理摘要。
// 全程不发任何真实网络请求，不监听任何端口。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  firstEnv,
  pickProxyEnv,
  parseProxyUrl,
  toProxyUrl,
  parseNoProxy,
  shouldBypassProxy,
  resolveProxy,
  resolveProxyAsync,
  detectLocalProxy,
  resetAutoProxyCache,
  mergeHeaders,
  describeProxy,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
} = require('../lib/http');

/** 本机实际环境变量（主理人实测环境）。 */
const REAL_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:7990/',
  HTTPS_PROXY: 'http://127.0.0.1:7990/',
  NO_PROXY: 'localhost,127.0.0.1,::1',
};

// ─────────────────────── firstEnv / pickProxyEnv ───────────────────────

test('firstEnv 按顺序取第一个非空值并 trim', () => {
  assert.equal(firstEnv({ A: '  x  ', B: 'y' }, ['A', 'B']), 'x');
  assert.equal(firstEnv({ A: '   ', B: 'y' }, ['A', 'B']), 'y');
  assert.equal(firstEnv({}, ['A']), '');
  assert.equal(firstEnv(null, ['A']), '');
  assert.equal(firstEnv({ A: 123 }, ['A']), '', '非字符串值必须忽略');
});

test('pickProxyEnv 大小写变体都认，https 目标优先 HTTPS_PROXY', () => {
  assert.equal(pickProxyEnv({ HTTPS_PROXY: 'http://a:1' }, 'https:'), 'http://a:1');
  assert.equal(pickProxyEnv({ https_proxy: 'http://b:2' }, 'https:'), 'http://b:2');
  assert.equal(pickProxyEnv({ HTTP_PROXY: 'http://c:3' }, 'http:'), 'http://c:3');
  assert.equal(pickProxyEnv({ http_proxy: 'http://d:4' }, 'http:'), 'http://d:4');
  assert.equal(pickProxyEnv({ ALL_PROXY: 'http://e:5' }, 'https:'), 'http://e:5');
  // HTTPS_PROXY 优先于 HTTP_PROXY
  assert.equal(
    pickProxyEnv({ HTTPS_PROXY: 'http://s:1', HTTP_PROXY: 'http://p:2' }, 'https:'),
    'http://s:1',
  );
  // https 目标在只有 HTTP_PROXY 时回落（与 npm/git 的惯例一致）
  assert.equal(pickProxyEnv({ HTTP_PROXY: 'http://p:2' }, 'https:'), 'http://p:2');
  // http 目标不会误用 HTTPS_PROXY
  assert.equal(pickProxyEnv({ HTTPS_PROXY: 'http://s:1' }, 'http:'), '');
  // 协议写法容错
  assert.equal(pickProxyEnv({ HTTPS_PROXY: 'http://s:1' }, 'https'), 'http://s:1');
  assert.equal(pickProxyEnv({}, 'https:'), '');
});

// ─────────────────────── parseProxyUrl / toProxyUrl ───────────────────────

test('parseProxyUrl 解析本机真实代理 http://127.0.0.1:7990/', () => {
  const p = parseProxyUrl('http://127.0.0.1:7990/');
  assert.deepEqual(p, {
    protocol: 'http:',
    hostname: '127.0.0.1',
    port: 7990,
    auth: '',
    href: 'http://127.0.0.1:7990',
  });
});

test('parseProxyUrl 容错：缺协议头补 http、带账号密码、默认端口', () => {
  assert.equal(parseProxyUrl('127.0.0.1:7990').port, 7990);
  assert.equal(parseProxyUrl('127.0.0.1:7990').protocol, 'http:');
  assert.equal(parseProxyUrl('http://proxy.corp').port, 80);
  assert.equal(parseProxyUrl('https://proxy.corp').port, 443);

  const withAuth = parseProxyUrl('http://alice:s%40cret@proxy.corp:8080');
  assert.equal(withAuth.auth, 'alice:s@cret');
  assert.equal(withAuth.hostname, 'proxy.corp');
  assert.equal(withAuth.port, 8080);
});

test('parseProxyUrl 非法/不支持的值一律返回 null（等同不走代理，绝不抛）', () => {
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl('   '), null);
  assert.equal(parseProxyUrl(null), null);
  assert.equal(parseProxyUrl(undefined), null);
  assert.equal(parseProxyUrl('socks5://127.0.0.1:1080'), null, 'socks 不支持，必须降级为直连');
  assert.equal(parseProxyUrl('ftp://127.0.0.1:21'), null);
  assert.equal(parseProxyUrl('http://:99999'), null);
});

test('toProxyUrl 还原成可传给 yt-dlp --proxy 的地址', () => {
  assert.equal(toProxyUrl(parseProxyUrl('http://127.0.0.1:7990/')), 'http://127.0.0.1:7990');
  assert.equal(toProxyUrl(parseProxyUrl('http://alice:pw@proxy.corp:8080')), 'http://alice:pw@proxy.corp:8080');
  assert.equal(toProxyUrl(null), '');
  assert.equal(toProxyUrl({}), '');
});

// ─────────────────────── NO_PROXY ───────────────────────

test('parseNoProxy 支持逗号/空白分隔，并归一化为小写', () => {
  assert.deepEqual(parseNoProxy('localhost,127.0.0.1,::1'), ['localhost', '127.0.0.1', '::1']);
  assert.deepEqual(parseNoProxy(' A.COM , b.com '), ['a.com', 'b.com']);
  assert.deepEqual(parseNoProxy('a.com b.com'), ['a.com', 'b.com']);
  assert.deepEqual(parseNoProxy(''), []);
  assert.deepEqual(parseNoProxy(null), []);
  assert.deepEqual(parseNoProxy(['A.com', ' b.com ']), ['a.com', 'b.com']);
});

test('shouldBypassProxy 命中本机真实 NO_PROXY=localhost,127.0.0.1,::1', () => {
  const np = REAL_ENV.NO_PROXY;
  assert.equal(shouldBypassProxy('localhost', np), true);
  assert.equal(shouldBypassProxy('127.0.0.1', np), true);
  assert.equal(shouldBypassProxy('::1', np), true);
  assert.equal(shouldBypassProxy('[::1]', np), true, 'URL 里的 IPv6 带方括号也要认');
  // 外网域名不得被绕过，否则又会走直连超时
  assert.equal(shouldBypassProxy('github.com', np), false);
  assert.equal(shouldBypassProxy('wallhaven.cc', np), false);
  assert.equal(shouldBypassProxy('www.youtube.com', np), false);
  assert.equal(shouldBypassProxy('html.duckduckgo.com', np), false);
});

test('shouldBypassProxy 支持 *、后缀匹配、host:port 与大小写', () => {
  assert.equal(shouldBypassProxy('anything.com', '*'), true);
  assert.equal(shouldBypassProxy('api.example.com', 'example.com'), true, '裸域条目应覆盖子域');
  assert.equal(shouldBypassProxy('api.example.com', '.example.com'), true);
  assert.equal(shouldBypassProxy('api.example.com', '*.example.com'), true);
  assert.equal(shouldBypassProxy('example.com', 'example.com'), true);
  assert.equal(shouldBypassProxy('notexample.com', 'example.com'), false, '不能被后缀误伤');
  assert.equal(shouldBypassProxy('example.com:8080', 'example.com'), false, '入参应是主机名而非 host:port');
  assert.equal(shouldBypassProxy('example.com', 'example.com:8080'), true, '条目带端口按主机名匹配');
  assert.equal(shouldBypassProxy('API.Example.COM', 'example.com'), true);
  assert.equal(shouldBypassProxy('example.com.', 'example.com'), true, '尾点 FQDN 要归一化');
  assert.equal(shouldBypassProxy('', 'example.com'), false);
  assert.equal(shouldBypassProxy('example.com', ''), false);
  assert.equal(shouldBypassProxy('example.com', null), false);
});

// ─────────────────────── resolveProxy ───────────────────────

test('resolveProxy 在本机真实环境下：外网走代理、NO_PROXY 命中直连', () => {
  const gh = resolveProxy('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', REAL_ENV);
  assert.ok(gh, 'github 必须走代理，否则本机 100% 超时');
  assert.equal(toProxyUrl(gh), 'http://127.0.0.1:7990');

  assert.ok(resolveProxy('https://wallhaven.cc/api/v1/search?q=x', REAL_ENV));
  assert.ok(resolveProxy('https://html.duckduckgo.com/html/?q=x', REAL_ENV));
  assert.ok(resolveProxy('https://i.ytimg.com/vi/x/maxresdefault.jpg', REAL_ENV));

  // NO_PROXY 命中 → 直连
  assert.equal(resolveProxy('http://127.0.0.1:3000/api', REAL_ENV), null);
  assert.equal(resolveProxy('http://localhost:8080/', REAL_ENV), null);
});

test('resolveProxy 未配置代理时返回 null（直连）', () => {
  assert.equal(resolveProxy('https://github.com/', {}), null);
  assert.equal(resolveProxy('https://github.com/', { NO_PROXY: '*', HTTPS_PROXY: 'http://127.0.0.1:7990' }), null);
  // 非法 URL 不抛异常
  assert.equal(resolveProxy('not a url', REAL_ENV), null);
  assert.equal(resolveProxy('', REAL_ENV), null);
});

test('describeProxy 输出可读的通道摘要', () => {
  assert.equal(describeProxy('https://github.com/', REAL_ENV), 'via http://127.0.0.1:7990');
  assert.equal(describeProxy('http://127.0.0.1:1234/', REAL_ENV), 'direct');
  assert.equal(describeProxy('https://github.com/', {}), 'direct');
});

// ─────────────────────── mergeHeaders / 常量 ───────────────────────

test('mergeHeaders 大小写不敏感，调用方的头优先', () => {
  const merged = mergeHeaders(
    { 'User-Agent': 'default-ua', Accept: '*/*', 'Accept-Encoding': 'identity' },
    { 'user-agent': 'caller-ua' },
  );
  assert.equal(merged['user-agent'], 'caller-ua');
  assert.equal(merged['User-Agent'], undefined, '同名头不得重复出现');
  assert.equal(merged.Accept, '*/*');
  assert.equal(merged['Accept-Encoding'], 'identity');
});

test('mergeHeaders 忽略 undefined/null 值并容忍空入参', () => {
  assert.deepEqual(mergeHeaders({ A: '1' }, { B: undefined, C: null }), { A: '1' });
  assert.deepEqual(mergeHeaders({ A: '1' }, null), { A: '1' });
  assert.deepEqual(mergeHeaders(null, { A: '1' }), { A: '1' });
});

test('默认 UA 必须是浏览器 UA（DuckDuckGo 无 UA 直接拒绝），重定向上限足够 GitHub 两跳', () => {
  assert.ok(DEFAULT_USER_AGENT.includes('Mozilla/5.0'));
  assert.ok(MAX_REDIRECTS >= 2);
});

// ─────────────────────── 本地代理自动探测（方案 A） ───────────────────────

/** 起一个最小 HTTP 代理替身：只响应 CONNECT 200（探测只关心隧道能否建立）。 */
function startFakeProxy() {
  const net = require('net');
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        socket.end();
      });
      socket.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('detectLocalProxy：本机有可用代理端口时自动识别（注入端口，不发真实外网请求）', async () => {
  resetAutoProxyCache();
  const srv = await startFakeProxy();
  try {
    const port = srv.address().port;
    const px = await detectLocalProxy({}, [port]);
    assert.ok(px, '应探测到本地代理');
    assert.equal(px.hostname, '127.0.0.1');
    assert.equal(px.port, port);
  } finally {
    srv.close();
    resetAutoProxyCache();
  }
});

test('detectLocalProxy：无监听端口时返回 null 且缓存不误报', async () => {
  resetAutoProxyCache();
  const px = await detectLocalProxy({}, [1]); // 1 号端口几乎必然无监听
  assert.equal(px, null);
  resetAutoProxyCache();
});

test('detectLocalProxy：MATERIAL_NO_AUTO_PROXY=1 时禁用自动探测', async () => {
  resetAutoProxyCache();
  const px = await detectLocalProxy({ MATERIAL_NO_AUTO_PROXY: '1' }, [7990]);
  assert.equal(px, null);
  resetAutoProxyCache();
});

test('resolveProxyAsync：测试注入 env（非 process.env）不触发自动探测', async () => {
  resetAutoProxyCache();
  const px = await resolveProxyAsync('https://www.google.com/', {});
  assert.equal(px, null, '注入 env 的调用方不应触发本机自动探测');
  resetAutoProxyCache();
});
