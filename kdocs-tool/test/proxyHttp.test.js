// proxyHttp.test.js —— 代理感知 HTTP 层纯函数单元测试（绝不发真实网络请求）
const test = require("node:test");
const assert = require("node:assert");
const { parseProxyUrl, shouldBypassProxy, pickProxyEnv, resolveProxy, firstEnv } = require("../lib/proxyHttp");

test("parseProxyUrl 补全缺协议头", () => {
  assert.deepStrictEqual(parseProxyUrl("127.0.0.1:7990"), {
    protocol: "http:", hostname: "127.0.0.1", port: 7990, auth: "", href: "http://127.0.0.1:7990",
  });
});

test("parseProxyUrl 带账号密码", () => {
  const p = parseProxyUrl("http://user:pass@proxy.example.com:8080");
  assert.strictEqual(p.hostname, "proxy.example.com");
  assert.strictEqual(p.port, 8080);
  assert.strictEqual(p.auth, "user:pass");
});

test("parseProxyUrl 非法值返回 null（socks / 无 host / 坏端口）", () => {
  assert.strictEqual(parseProxyUrl("socks5://127.0.0.1:1080"), null);
  assert.strictEqual(parseProxyUrl("ftp://x"), null);
  assert.strictEqual(parseProxyUrl("not a url"), null);
  assert.strictEqual(parseProxyUrl(""), null);
});

test("pickProxyEnv https 回落到 HTTPS_PROXY / HTTP_PROXY", () => {
  const env = { HTTP_PROXY: "http://h1:80", HTTPS_PROXY: "http://h2:443" };
  assert.strictEqual(pickProxyEnv(env, "https:"), "http://h2:443");
  assert.strictEqual(pickProxyEnv(env, "http:"), "http://h1:80");
});

test("shouldBypassProxy 支持 * / .suffix / host / 大小写", () => {
  assert.strictEqual(shouldBypassProxy("api.bgm.tv", "*.bgm.tv"), true);
  assert.strictEqual(shouldBypassProxy("api.bgm.tv", "api.bgm.tv"), true);
  assert.strictEqual(shouldBypassProxy("api.bgm.tv", "NO_PROXY=localhost,127.0.0.1"), false);
  assert.strictEqual(shouldBypassProxy("anything", "*"), true);
  assert.strictEqual(shouldBypassProxy("zh.wikipedia.org", "localhost,127.0.0.1"), false);
});

test("resolveProxy 命中 NO_PROXY 返回 null（直连）", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:7990", NO_PROXY: "api.bgm.tv" };
  assert.strictEqual(resolveProxy("https://api.bgm.tv/search/subject/x", env), null);
});

test("resolveProxy 普通 https 目标返回解析后的代理", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:7990" };
  const p = resolveProxy("https://www.wikidata.org/w/api.php", env);
  assert.strictEqual(p.hostname, "127.0.0.1");
  assert.strictEqual(p.port, 7990);
});

test("resolveProxy 无代理配置且 env 非 process.env 时返回 null（单测隔离）", () => {
  // 注入空 env 对象（!== process.env）→ 不会去读本机 .proxy 文件
  assert.strictEqual(resolveProxy("https://www.wikidata.org/w/api.php", {}), null);
});

test("firstEnv 取首个非空（大小写变体都认）", () => {
  assert.strictEqual(firstEnv({ https_proxy: "http://a:1", HTTPS_PROXY: "http://b:2" }, ["HTTPS_PROXY", "https_proxy"]), "http://b:2");
  assert.strictEqual(firstEnv({}, ["HTTPS_PROXY"]), "");
});
