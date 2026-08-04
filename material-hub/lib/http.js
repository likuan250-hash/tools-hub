// lib/http.js —— 代理感知的 HTTP/HTTPS 请求工具（零第三方依赖，Node 内置 http/https/tls 手写）
//
// 背景（缺陷 2）：Node 的内置 http/https 模块**不会**自动读取 HTTP_PROXY/HTTPS_PROXY 环境变量。
// 在直连 github.com / wallhaven.cc / duckduckgo.com 被墙的开发机与用户机上，
// scripts/prepare-material-bins.js 与 lib/cover.js 的所有网络请求都会静默超时 →
// 「点击运行一直不成功」。本模块提供统一的代理感知请求能力：
//   · 读取 HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy / ALL_PROXY / all_proxy（大小写都认）
//   · 尊重 NO_PROXY / no_proxy（命中则直连；支持 *、.suffix、host:port、IPv6）
//   · HTTPS 经 HTTP 代理走 CONNECT 隧道：http.request({method:'CONNECT'}) 拿 socket → tls.connect({socket})
//   · 自动跟随 30x（GitHub release 会连跳两次到 release-assets.githubusercontent.com）
//   · 可配超时、可传 User-Agent（DuckDuckGo 不带 UA 直接拒绝）
//   · 同时支持「下载到文件」(downloadToFile) 与「读成 Buffer/文本/JSON」(fetchBuffer/fetchText/fetchJson)
//   · 另提供 WHATWG fetch 形态的 proxyFetch，便于 lib/cover.js 原样替换 globalThis.fetch
//
// 纯函数（parseProxyUrl / parseNoProxy / shouldBypassProxy / pickProxyEnv / resolveProxy / toProxyUrl）
// 全部可单测，测试中绝不发真实网络请求。
const http = require('http');
const https = require('https');
const fsDefault = require('fs');
const pathMod = require('path');

/** 默认超时（下载 18MB 的 yt-dlp.exe 经代理约 25s，留足余量）。 */
const DEFAULT_TIMEOUT = 120 * 1000;
/** 默认 UA：壁纸站 / DuckDuckGo 对无 UA 请求一律拒绝。 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 最大重定向跳数，防环。 */
const MAX_REDIRECTS = 8;

/** https 目标的代理环境变量查找顺序。 */
const PROXY_ENV_KEYS_HTTPS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
/** http 目标的代理环境变量查找顺序（不回落到 HTTPS_PROXY）。 */
const PROXY_ENV_KEYS_HTTP = ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
/** NO_PROXY 环境变量查找顺序。 */
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];

/**
 * 按给定顺序取第一个非空环境变量值。
 * @param {object} env 环境变量对象
 * @param {string[]} keys 候选键名（大小写变体都要列出）
 * @returns {string} 命中的值（已 trim）；都没有时返回空串
 */
function firstEnv(env, keys) {
  const src = env && typeof env === 'object' ? env : {};
  for (const key of keys) {
    const raw = src[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return '';
}

/**
 * 按目标协议挑出应使用的代理环境变量原始值。
 * @param {object} env 环境变量对象
 * @param {string} protocol 目标协议，如 'https:' / 'https' / 'http:'
 * @returns {string} 代理地址原始串；未配置返回空串
 */
function pickProxyEnv(env, protocol) {
  const p = String(protocol == null ? '' : protocol).toLowerCase();
  const isHttps = p.indexOf('https') === 0;
  return firstEnv(env, isHttps ? PROXY_ENV_KEYS_HTTPS : PROXY_ENV_KEYS_HTTP);
}

/**
 * 解析代理地址。
 * 兼容缺协议头的写法（`127.0.0.1:7990` → 按 http 处理）与带账号密码的写法。
 * @param {string} raw 代理地址，如 'http://127.0.0.1:7990/'
 * @returns {{protocol: string, hostname: string, port: number, auth: string, href: string}|null}
 *   解析失败返回 null（非法值等同于「不走代理」，绝不抛异常）
 */
function parseProxyUrl(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // socks 代理本模块不支持（需要额外协议实现），直接视为未配置
  if (/^socks/i.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;

  let u = null;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  const protocol = String(u.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  const hostname = String(u.hostname || '');
  if (!hostname) return null;
  const port = u.port ? Number.parseInt(u.port, 10) : (protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const user = u.username ? decodeURIComponent(u.username) : '';
  const pass = u.password ? decodeURIComponent(u.password) : '';
  const auth = user || pass ? user + ':' + pass : '';
  return { protocol, hostname, port, auth, href: protocol + '//' + hostname + ':' + port };
}

/**
 * 把解析结果还原成可传给子进程（yt-dlp --proxy）的完整地址，含账号密码。
 * @param {{protocol: string, hostname: string, port: number, auth: string}|null} proxy parseProxyUrl 结果
 * @returns {string} 形如 'http://127.0.0.1:7990'；proxy 为空时返回空串
 */
function toProxyUrl(proxy) {
  if (!proxy || !proxy.hostname) return '';
  const credential = proxy.auth ? encodeURIComponent(proxy.auth.split(':')[0]) + ':'
    + encodeURIComponent(proxy.auth.slice(proxy.auth.indexOf(':') + 1)) + '@' : '';
  return proxy.protocol + '//' + credential + proxy.hostname + ':' + proxy.port;
}

/**
 * 把 NO_PROXY 原始串切成条目列表。
 * @param {string|string[]} raw 形如 'localhost,127.0.0.1,::1' 或已切好的数组
 * @returns {string[]} 小写条目
 */
function parseNoProxy(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s == null ? '' : s).trim().toLowerCase()).filter((s) => s.length > 0);
  }
  return String(raw == null ? '' : raw)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * 判断目标主机是否命中 NO_PROXY（命中则必须直连）。
 * 支持：`*`（全部直连）、`example.com`（含子域）、`.example.com`、`*.example.com`、
 * `example.com:8080`（按主机名匹配，忽略端口）、IPv4 / IPv6 字面量。
 * @param {string} hostname 目标主机名（可带 [] 的 IPv6 形式）
 * @param {string|string[]} noProxy NO_PROXY 原始串或条目数组
 * @returns {boolean} true = 绕过代理直连
 */
function shouldBypassProxy(hostname, noProxy) {
  const host = String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  const list = parseNoProxy(noProxy);
  if (!list.length) return false;
  if (list.indexOf('*') >= 0) return true;

  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  for (const item of list) {
    let entry = item.replace(/^\*/, '');
    entry = entry.replace(/^\[/, '').replace(/\]$/, '');
    // 条目形如 example.com:8080 时按主机名匹配（IPv6 字面量含 '::'，不能误剥）
    if (entry.indexOf('::') < 0) entry = entry.replace(/:\d+$/, '');
    if (!entry) continue;
    if (entry === bare) return true;
    const suffix = entry[0] === '.' ? entry : '.' + entry;
    if (bare.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * 针对某个目标地址解析最终该用的代理（已应用 NO_PROXY 判定）。
 * @param {string|URL} target 目标地址
 * @param {object} [env=process.env] 环境变量来源（单测注入）
 * @returns {{protocol: string, hostname: string, port: number, auth: string, href: string}|null}
 *   null 表示直连
 */
function resolveProxy(target, env) {
  const source = env && typeof env === 'object' ? env : process.env;
  let u = null;
  try {
    u = typeof target === 'string' ? new URL(target) : target;
  } catch (e) {
    return null;
  }
  if (!u || !u.protocol || !u.hostname) return null;
  if (shouldBypassProxy(u.hostname, firstEnv(source, NO_PROXY_ENV_KEYS))) return null;
  const url = pickProxyEnv(source, u.protocol);
  if (url) return parseProxyUrl(url);
  // 当且仅当 source 是真实 process.env 时才读 .proxy 文件。
  //   CoverFetcher 会把 process.env 写进 this.env 再传给每一次 fetch；
  //   但这里的 source 永远等于形参 env（或 process.env），所以 source===process.env
  //   意味着「调用方没注入 env→现在读的是真实环境→应该补 .proxy 兜底」；
  //   测试里 env={} 会让 source!==process.env，.proxy 不会被读到，不受本机配置干扰。
  if (source === process.env) {
    try {
      // 优先 .proxy（用户配置），不存在则回退到 .proxy.example（仓库模板）
      const base = pathMod.join(__dirname, '..');
      for (const name of ['.proxy', '.proxy.example']) {
        const cfgPath = pathMod.join(base, name);
        if (fsDefault.existsSync(cfgPath)) {
          const cfg = fsDefault.readFileSync(cfgPath, 'utf8').split('\n')[0].trim();
          if (cfg) return parseProxyUrl(cfg);
        }
      }
    } catch (e) { /* 文件不存在或不可读，静默跳过 */ }
  }
  return null;
}

/**
 * 大小写不敏感地合并请求头：defaults 里已被 extra 覆盖的键不再重复添加。
 * @param {object} defaults 默认头
 * @param {object} extra 调用方头（优先）
 * @returns {object} 合并结果
 */
function mergeHeaders(defaults, extra) {
  const out = {};
  const taken = new Set();
  const src = extra && typeof extra === 'object' ? extra : {};
  for (const key of Object.keys(src)) {
    if (src[key] === undefined || src[key] === null) continue;
    out[key] = src[key];
    taken.add(key.toLowerCase());
  }
  const base = defaults && typeof defaults === 'object' ? defaults : {};
  for (const key of Object.keys(base)) {
    if (taken.has(key.toLowerCase())) continue;
    out[key] = base[key];
  }
  return out;
}

/**
 * 经 HTTP 代理开一条到目标主机的 CONNECT 隧道，拿到裸 TCP socket。
 * 这是「HTTPS 经 HTTP 代理」的唯一正确姿势：代理只负责透传字节，TLS 握手仍与目标站直接完成。
 * @param {{hostname: string, port: number, auth: string}} proxy 代理信息
 * @param {string} host 目标主机名
 * @param {number} port 目标端口
 * @param {number} timeout 超时毫秒
 * @returns {Promise<import('net').Socket>} 隧道 socket
 */
function openProxyTunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const target = host + ':' + port;
    const headers = { Host: target, 'Proxy-Connection': 'keep-alive' };
    if (proxy.auth) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth, 'utf8').toString('base64');
    }
    let settled = false;
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: target,
      headers,
      agent: false,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* 已销毁 */ }
      reject(new Error('代理 CONNECT 超时（' + Math.round(timeout / 1000) + 's）：' + target));
    }, timeout);
    if (timer.unref) timer.unref();

    req.on('connect', (res, socket) => {
      if (settled) { try { socket.destroy(); } catch (e) { /* 已销毁 */ } return; }
      settled = true;
      clearTimeout(timer);
      const status = res && res.statusCode ? res.statusCode : 0;
      if (status !== 200) {
        try { socket.destroy(); } catch (e) { /* 已销毁 */ }
        reject(new Error('代理 CONNECT 失败：HTTP ' + status + '（' + proxy.hostname + ':' + proxy.port + '）'));
        return;
      }
      resolve(socket);
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('无法连接代理 ' + proxy.hostname + ':' + proxy.port + '：' + (e && e.message ? e.message : String(e))));
    });
    req.end();
  });
}

/**
 * 发起一次请求（不处理重定向），返回原始响应流。
 * @param {string} targetUrl 目标地址
 * @param {{
 *   method?: string, headers?: object, timeout?: number, userAgent?: string,
 *   env?: object, proxy?: object|null
 * }} [opts] proxy 显式传 null 可强制直连
 * @returns {Promise<{res: import('http').IncomingMessage, proxy: object|null, url: string}>}
 */
function requestOnce(targetUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    let u = null;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      reject(new Error('非法 URL：' + String(targetUrl)));
      return;
    }
    const isHttps = u.protocol === 'https:';
    if (!isHttps && u.protocol !== 'http:') {
      reject(new Error('不支持的协议：' + u.protocol));
      return;
    }
    const port = u.port ? Number.parseInt(u.port, 10) : (isHttps ? 443 : 80);
    const method = String(opts.method || 'GET').toUpperCase();
    const timeout = Number.isFinite(opts.timeout) && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT;
    const proxy = opts.proxy !== undefined ? opts.proxy : resolveProxy(u, opts.env);
    const headers = mergeHeaders({
      'User-Agent': opts.userAgent || DEFAULT_USER_AGENT,
      Accept: '*/*',
      // 本模块不做解压，强制服务端返回原始字节，避免拿到 gzip 乱码
      'Accept-Encoding': 'identity',
      Connection: 'close',
    }, opts.headers);

    let settled = false;
    let req = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (req) { try { req.destroy(); } catch (e) { /* 已销毁 */ } }
      reject(new Error('请求超时（' + Math.round(timeout / 1000) + 's）：' + targetUrl));
    }, timeout);
    if (timer.unref) timer.unref();

    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const succeed = (res) => {
      if (settled) { try { res.destroy(); } catch (e) { /* 已销毁 */ } return; }
      settled = true;
      clearTimeout(timer);
      resolve({ res, proxy, url: targetUrl });
    };

    const start = async () => {
      // ① 直连
      if (!proxy) {
        const mod = isHttps ? https : http;
        req = mod.request({
          host: u.hostname,
          port,
          path: (u.pathname || '/') + (u.search || ''),
          method,
          headers,
          agent: false,
        }, succeed);
        req.on('error', fail);
        req.end();
        return;
      }
      // ② 明文 HTTP 经代理：请求行里放绝对 URL 即可，无需隧道
      if (!isHttps) {
        const proxied = Object.assign({}, headers, { Host: u.host });
        if (proxy.auth) {
          proxied['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth, 'utf8').toString('base64');
        }
        req = http.request({
          host: proxy.hostname,
          port: proxy.port,
          path: u.href,
          method,
          headers: proxied,
          agent: false,
        }, succeed);
        req.on('error', fail);
        req.end();
        return;
      }
      // ③ HTTPS 经代理：CONNECT 隧道 + 在隧道 socket 上做 TLS
      // 注意：本机 Node 版本下 https.request 不会调用 createConnection（agent:false 时直接连目标），
      // 因此这里把「原始隧道 socket」通过 socket 选项交给 https.request，由它自己在隧道上完成 TLS 握手。
      const socket = await openProxyTunnel(proxy, u.hostname, port, timeout);
      if (settled) { try { socket.destroy(); } catch (e) { /* 已销毁 */ } return; }
      req = https.request({
        host: u.hostname,
        port,
        path: (u.pathname || '/') + (u.search || ''),
        method,
        headers,
        agent: false,
        socket,
        servername: u.hostname,
      }, succeed);
      req.on('error', fail);
      req.end();
    };

    start().catch(fail);
  });
}

/**
 * 发起请求并自动跟随 30x 重定向。
 * @param {string} targetUrl 目标地址
 * @param {{
 *   method?: string, headers?: object, timeout?: number, userAgent?: string,
 *   env?: object, proxy?: object|null, maxRedirects?: number,
 *   redirect?: string, onRedirect?: (status: number, next: string) => void
 * }} [opts] redirect='manual' 时不跟随
 * @returns {Promise<{
 *   res: import('http').IncomingMessage, status: number, headers: object,
 *   url: string, proxy: object|null, redirects: number
 * }>}
 */
async function requestFollow(targetUrl, opts = {}) {
  const max = Number.isFinite(opts.maxRedirects) ? Math.max(0, opts.maxRedirects) : MAX_REDIRECTS;
  const follow = opts.redirect !== 'manual';
  let url = String(targetUrl);
  for (let hop = 0; hop <= max; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const got = await requestOnce(url, opts);
    const res = got.res;
    const status = res.statusCode || 0;
    const location = res.headers && res.headers.location ? String(res.headers.location) : '';
    if (follow && status >= 300 && status < 400 && location) {
      res.resume();
      let next = '';
      try {
        next = new URL(location, url).toString();
      } catch (e) {
        next = '';
      }
      if (!next) {
        return { res, status, headers: res.headers || {}, url, proxy: got.proxy, redirects: hop };
      }
      if (typeof opts.onRedirect === 'function') {
        try { opts.onRedirect(status, next); } catch (e) { /* 回调异常不影响下载 */ }
      }
      url = next;
      continue;
    }
    return { res, status, headers: res.headers || {}, url, proxy: got.proxy, redirects: hop };
  }
  throw new Error('重定向次数超过 ' + max + ' 次：' + targetUrl);
}

/**
 * 把响应体读成 Buffer。
 * @param {import('http').IncomingMessage} res 响应流
 * @param {{timeout?: number, maxBytes?: number, onProgress?: (received: number, total: number) => void}} [opts]
 * @returns {Promise<Buffer>}
 */
function readBody(res, opts = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const total = Number(res.headers && res.headers['content-length']) || 0;
    const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 0;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    let received = 0;
    let settled = false;

    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { res.destroy(); } catch (err) { /* 已销毁 */ }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    // 空闲超时：防止服务端挂着连接不发数据把流程拖死
    if (Number.isFinite(opts.timeout) && opts.timeout > 0 && typeof res.setTimeout === 'function') {
      res.setTimeout(opts.timeout, () => fail(new Error('读取响应体超时（' + Math.round(opts.timeout / 1000) + 's）')));
    }

    res.on('data', (chunk) => {
      received += chunk.length;
      if (maxBytes && received > maxBytes) {
        fail(new Error('响应体超过上限 ' + maxBytes + ' 字节'));
        return;
      }
      chunks.push(chunk);
      if (onProgress) onProgress(received, total);
    });
    res.on('error', fail);
    res.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, received));
    });
  });
}

/**
 * GET 一个地址并把响应体读成 Buffer（代理感知 + 跟随重定向）。
 * @param {string} url 目标地址
 * @param {object} [opts] 见 requestFollow / readBody
 * @returns {Promise<{ok: boolean, status: number, headers: object, url: string, buffer: Buffer, proxy: object|null}>}
 */
async function fetchBuffer(url, opts = {}) {
  const r = await requestFollow(url, opts);
  const buffer = await readBody(r.res, {
    timeout: opts.timeout,
    maxBytes: opts.maxBytes,
    onProgress: opts.onProgress,
  });
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: r.headers,
    url: r.url,
    buffer,
    proxy: r.proxy,
  };
}

/**
 * GET 一个地址并把响应体读成文本。
 * @param {string} url 目标地址
 * @param {object} [opts] 见 fetchBuffer
 * @returns {Promise<{ok: boolean, status: number, headers: object, url: string, text: string}>}
 */
async function fetchText(url, opts = {}) {
  const r = await fetchBuffer(url, opts);
  return { ok: r.ok, status: r.status, headers: r.headers, url: r.url, text: r.buffer.toString('utf8') };
}

/**
 * GET 一个 JSON 接口。
 * @param {string} url 目标地址
 * @param {object} [opts] 见 fetchBuffer
 * @returns {Promise<{ok: boolean, status: number, headers: object, url: string, json: object|null}>}
 */
async function fetchJson(url, opts = {}) {
  const r = await fetchBuffer(url, Object.assign({}, opts, {
    headers: mergeHeaders({ Accept: 'application/json' }, opts.headers),
  }));
  let json = null;
  try {
    json = JSON.parse(r.buffer.toString('utf8'));
  } catch (e) {
    throw new Error('响应不是合法 JSON（HTTP ' + r.status + '）');
  }
  return { ok: r.ok, status: r.status, headers: r.headers, url: r.url, json };
}

/**
 * 下载到本地文件（先写 `.download` 临时文件，成功后原子改名，避免留下半截文件被误判为已就位）。
 * @param {string} url 下载地址
 * @param {string} dest 目标文件绝对路径
 * @param {{
 *   fs?: object, timeout?: number, headers?: object, userAgent?: string, env?: object,
 *   minBytes?: number, onProgress?: (received: number, total: number) => void,
 *   onRedirect?: (status: number, next: string) => void
 * }} [opts]
 * @returns {Promise<{ok: boolean, status: number, bytes: number, path: string, url: string, proxy: object|null}>}
 */
async function downloadToFile(url, dest, opts = {}) {
  const fs = opts.fs || fsDefault;
  const minBytes = Number.isFinite(opts.minBytes) && opts.minBytes > 0 ? opts.minBytes : 0;
  const r = await requestFollow(url, opts);
  if (r.status !== 200) {
    r.res.resume();
    throw new Error('HTTP ' + r.status + '：' + r.url);
  }

  const total = Number(r.headers['content-length']) || 0;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const tmp = dest + '.download';
  fs.mkdirSync(pathMod.dirname(dest), { recursive: true });

  const bytes = await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { r.res.destroy(); } catch (err) { /* 已销毁 */ }
      try { out.destroy(); } catch (err) { /* 已销毁 */ }
      try { fs.unlinkSync(tmp); } catch (err) { /* 清理失败不阻断报错 */ }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    if (Number.isFinite(opts.timeout) && opts.timeout > 0 && typeof r.res.setTimeout === 'function') {
      r.res.setTimeout(opts.timeout, () => fail(new Error('下载超时（' + Math.round(opts.timeout / 1000) + 's）：' + r.url)));
    }
    r.res.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    r.res.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(received);
    });
    r.res.pipe(out);
  });

  if (minBytes && bytes < minBytes) {
    try { fs.unlinkSync(tmp); } catch (e) { /* 清理失败不阻断报错 */ }
    throw new Error('下载体积异常（' + bytes + ' 字节，低于下限 ' + minBytes + '），疑似失败页');
  }
  try {
    // Windows 上 rename 到已存在文件会失败，先删旧
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(tmp, dest);
  } catch (e) {
    throw new Error('落盘失败：' + (e && e.message ? e.message : String(e)));
  }
  return { ok: true, status: r.status, bytes, path: dest, url: r.url, proxy: r.proxy };
}

/**
 * WHATWG fetch 形态的封装，便于把 `globalThis.fetch` 原样替换掉。
 * 传输层异常按 fetch 语义抛出；HTTP 非 2xx 只体现在 ok/status 上，不抛。
 * @param {string} url 目标地址
 * @param {{headers?: object, method?: string, timeout?: number, redirect?: string, env?: object}} [opts]
 * @returns {Promise<{
 *   ok: boolean, status: number, url: string, headers: object, buffer: Buffer,
 *   text: () => Promise<string>, json: () => Promise<object>, arrayBuffer: () => Promise<ArrayBuffer>
 * }>}
 */
async function proxyFetch(url, opts = {}) {
  const r = await fetchBuffer(url, opts);
  const buf = r.buffer;
  return {
    ok: r.ok,
    status: r.status,
    url: r.url,
    headers: r.headers,
    buffer: buf,
    async text() { return buf.toString('utf8'); },
    async json() { return JSON.parse(buf.toString('utf8')); },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

/**
 * 生成一行代理状态摘要，便于在日志里确认「到底走没走代理」。
 * @param {string} target 目标地址
 * @param {object} [env=process.env] 环境变量
 * @returns {string} 如 'via http://127.0.0.1:7990' 或 'direct'
 */
function describeProxy(target, env) {
  const p = resolveProxy(target, env);
  return p ? 'via ' + toProxyUrl(p) : 'direct';
}

module.exports = {
  // 纯函数（单测主战场）
  firstEnv,
  pickProxyEnv,
  parseProxyUrl,
  toProxyUrl,
  parseNoProxy,
  shouldBypassProxy,
  resolveProxy,
  mergeHeaders,
  describeProxy,
  // 带 IO
  openProxyTunnel,
  requestOnce,
  requestFollow,
  readBody,
  fetchBuffer,
  fetchText,
  fetchJson,
  downloadToFile,
  proxyFetch,
  // 常量
  DEFAULT_TIMEOUT,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  PROXY_ENV_KEYS_HTTPS,
  PROXY_ENV_KEYS_HTTP,
  NO_PROXY_ENV_KEYS,
};
