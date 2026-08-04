// lib/proxyHttp.js —— kdocs-tool 专用：代理感知 HTTP GET（零第三方依赖，Node 内置 http/https/fs/path）
//
// 背景：kdocs-tool 是 main.js 用 fork() 拉起的「独立 Node 子进程」，它**不读系统代理、
// 也不读 Windows 证书库**（Electron 的 net.fetch 才有这能力，但子进程不是 Electron 主进程）。
// 因此用户若在系统/客户端里配了 HTTP 代理，fork 子进程拿不到 → Wikipedia / Wikidata /
// 百度百科 等被墙/受限数据源依旧连不上。
//
// 本模块让这些请求在「配置了代理」时经 HTTP 代理的 CONNECT 隧道连通（与 material-hub/lib/http.js
// 同源思路，但自包含、不跨模块耦合）。未配置代理时退化为直连，行为与历史完全一致。
//
// 设计要点：
//   · 读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY（大小写都认）
//   · 尊重 NO_PROXY（命中直连）
//   · HTTPS 经 HTTP 代理走 CONNECT 隧道：http.request({method:'CONNECT'}) 拿 socket → https.get({socket})
//   · 自动跟随 30x（封顶 3 跳，防环）
//   · fetchTextProxy / fetchJsonProxy 任何异常 / 非 200 / 超时一律返回 null（上层「绝不抛错」语义）
//   · 纯函数（parseProxyUrl / shouldBypassProxy / resolveProxy / pickProxyEnv）可单测，绝不发真实请求
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

/** https 目标的代理环境变量查找顺序。 */
const PROXY_ENV_KEYS_HTTPS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
/** http 目标的代理环境变量查找顺序（不回落到 HTTPS_PROXY）。 */
const PROXY_ENV_KEYS_HTTP = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
/** NO_PROXY 环境变量查找顺序。 */
const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"];

/** 按给定顺序取第一个非空环境变量值。 */
function firstEnv(env, keys) {
  const src = env && typeof env === "object" ? env : {};
  for (const key of keys) {
    const raw = src[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return "";
}

/** 按目标协议挑出应使用的代理环境变量原始值。 */
function pickProxyEnv(env, protocol) {
  const p = String(protocol == null ? "" : protocol).toLowerCase();
  const isHttps = p.indexOf("https") === 0;
  return firstEnv(env, isHttps ? PROXY_ENV_KEYS_HTTPS : PROXY_ENV_KEYS_HTTP);
}

/** 解析代理地址（兼容 `127.0.0.1:7990` 缺协议头写法；socks 不支持；非法值返回 null，绝不抛）。 */
function parseProxyUrl(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (/^socks/i.test(s)) return null; // 本模块不支持 socks（需额外协议实现）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u = null;
  try { u = new URL(s); } catch (e) { return null; }
  const protocol = String(u.protocol || "").toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;
  const hostname = String(u.hostname || "");
  if (!hostname) return null;
  const port = u.port ? Number.parseInt(u.port, 10) : (protocol === "https:" ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  const user = u.username ? decodeURIComponent(u.username) : "";
  const pass = u.password ? decodeURIComponent(u.password) : "";
  const auth = user || pass ? user + ":" + pass : "";
  return { protocol, hostname, port, auth, href: protocol + "//" + hostname + ":" + port };
}

/** 把 NO_PROXY 原始串切成小写条目列表。 */
function parseNoProxy(raw) {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s == null ? "" : s).trim().toLowerCase()).filter((s) => s.length > 0);
  }
  return String(raw == null ? "" : raw)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** 目标主机是否命中 NO_PROXY（命中则直连）。支持 * / .suffix / host:port / IPv4/IPv6。 */
function shouldBypassProxy(hostname, noProxy) {
  const host = String(hostname == null ? "" : hostname).trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  const list = parseNoProxy(noProxy);
  if (!list.length) return false;
  if (list.indexOf("*") >= 0) return true;
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  for (const item of list) {
    let entry = item.replace(/^\*/, "");
    entry = entry.replace(/^\[/, "").replace(/\]$/, "");
    if (entry.indexOf("::") < 0) entry = entry.replace(/:\d+$/, ""); // IPv6 字面量含 :: 不剥端口
    if (!entry) continue;
    if (entry === bare) return true;
    const suffix = entry[0] === "." ? entry : "." + entry;
    if (bare.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * 解析目标最终该用的代理（已应用 NO_PROXY）。
 * source===process.env 时才补读 kdocs-tool 根的 .proxy / proxy-default 文件（用户自定义代理兜底），
 * 单测注入 env={} 时不会读到本机配置，隔离干净。
 */
function resolveProxy(target, env) {
  const source = env && typeof env === "object" ? env : process.env;
  let u = null;
  try { u = typeof target === "string" ? new URL(target) : target; } catch (e) { return null; }
  if (!u || !u.protocol || !u.hostname) return null;
  if (shouldBypassProxy(u.hostname, firstEnv(source, NO_PROXY_ENV_KEYS))) return null;
  const raw = pickProxyEnv(source, u.protocol);
  if (raw) return parseProxyUrl(raw);
  if (source === process.env) {
    try {
      const base = path.join(__dirname, ".."); // kdocs-tool/lib -> kdocs-tool
      for (const name of [".proxy", "proxy-default"]) {
        const cfgPath = path.join(base, name);
        if (fs.existsSync(cfgPath)) {
          const cfg = fs.readFileSync(cfgPath, "utf8").split("\n")[0].trim();
          if (cfg) return parseProxyUrl(cfg);
        }
      }
    } catch (e) { /* 文件不存在或不可读，静默跳过 */ }
  }
  return null;
}

/** 经 HTTP 代理开 CONNECT 隧道，拿到裸 TCP socket。 */
function openProxyTunnel(proxy, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const target = host + ":" + port;
    const headers = { Host: target, "Proxy-Connection": "keep-alive" };
    if (proxy.auth) headers["Proxy-Authorization"] = "Basic " + Buffer.from(proxy.auth, "utf8").toString("base64");
    let settled = false;
    const req = http.request({
      host: proxy.hostname, port: proxy.port, method: "CONNECT", path: target, headers, agent: false,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) { /* 已销毁 */ }
      reject(new Error("代理 CONNECT 超时（" + Math.round(timeout / 1000) + "s）：" + target));
    }, timeout);
    if (timer.unref) timer.unref();
    req.on("connect", (res, socket) => {
      if (settled) { try { socket.destroy(); } catch (e) { /* 已销毁 */ } return; }
      settled = true;
      clearTimeout(timer);
      const status = res && res.statusCode ? res.statusCode : 0;
      if (status !== 200) {
        try { socket.destroy(); } catch (e) { /* 已销毁 */ }
        reject(new Error("代理 CONNECT 失败：HTTP " + status + "（" + proxy.hostname + ":" + proxy.port + "）"));
        return;
      }
      resolve(socket);
    });
    req.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("无法连接代理 " + proxy.hostname + ":" + proxy.port + "：" + (e && e.message ? e.message : String(e))));
    });
    req.end();
  });
}

/**
 * 代理感知 GET 文本，跟随 30x（封顶 3 跳）。任何异常 / 非 200 / 超时返回 null。
 * @param {string} url 目标地址
 * @param {number} timeoutMs 超时毫秒
 * @param {object} [env] 环境变量来源（单测注入）；默认 process.env
 * @param {number} depth 重定向跳数
 * @param {boolean} acceptJson 是否在 Accept 头声明 application/json
 */
function requestText(url, timeoutMs, env, depth, acceptJson) {
  return new Promise((resolve) => {
    if (depth > 3) { resolve(null); return; }
    let u = null;
    try { u = new URL(url); } catch (e) { resolve(null); return; }
    const isHttps = u.protocol === "https:";
    const port = u.port ? Number.parseInt(u.port, 10) : (isHttps ? 443 : 80);
    const proxy = resolveProxy(u, env);
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
    let settled = false, req = null, timer = null;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Encoding": "identity", // 强制原始字节，避免 gzip 乱码
      Connection: "close",
      Accept: acceptJson ? "application/json" : "*/*",
    };
    const finish = (v) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        if (req) { try { req.destroy(); } catch (e) { /* 已销毁 */ } }
        resolve(v);
      }
    };
    timer = setTimeout(() => finish(null), timeout);
    if (timer.unref) timer.unref();
    const onErr = () => finish(null);

    const onRes = (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && depth < 3) {
        const loc = res.headers.location;
        res.resume();
        const next = loc.startsWith("http") ? loc : new URL(loc, u.href).href;
        settled = true; // 本请求已结束，进入下一跳递归
        if (timer) clearTimeout(timer);
        return requestText(next, timeoutMs, env, depth + 1, acceptJson).then(resolve);
      }
      if (status !== 200) { res.resume(); return finish(null); }
      const chunks = [];
      let size = 0;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        chunks.push(c);
        size += c.length;
        if (size > 5 * 1024 * 1024) { res.destroy(); finish(null); } // 防异常大响应拖死
      });
      res.on("end", () => finish(chunks.join("")));
      res.on("error", onErr);
    };

    const start = () => {
      if (!proxy) {
        const mod = isHttps ? https : http;
        req = mod.get({ host: u.hostname, port, path: (u.pathname || "/") + (u.search || ""), headers, timeout }, onRes);
        req.on("error", onErr);
      } else if (!isHttps) {
        const proxied = Object.assign({}, headers, { Host: u.host });
        if (proxy.auth) proxied["Proxy-Authorization"] = "Basic " + Buffer.from(proxy.auth, "utf8").toString("base64");
        req = http.get({ host: proxy.hostname, port: proxy.port, path: u.href, headers: proxied, timeout }, onRes);
        req.on("error", onErr);
      } else {
        // HTTPS 经 HTTP 代理：CONNECT 隧道 + 在隧道 socket 上做 TLS
        openProxyTunnel(proxy, u.hostname, port, timeout)
          .then((socket) => {
            if (settled) { try { socket.destroy(); } catch (e) { /* 已销毁 */ } return; }
            req = https.get({
              host: u.hostname, port, path: (u.pathname || "/") + (u.search || ""),
              headers, timeout, socket, servername: u.hostname,
            }, onRes);
            req.on("error", onErr);
          })
          .catch(onErr);
      }
    };
    start();
  });
}

/** 代理感知 GET 文本，失败返回 null（绝不抛错）。 */
function fetchTextProxy(url, opts = {}) {
  return requestText(url, opts.timeout || 10000, opts.env, 0, false);
}

/** 代理感知 GET JSON，失败（含非 JSON）返回 null（绝不抛错）。 */
function fetchJsonProxy(url, opts = {}) {
  return requestText(url, opts.timeout || 10000, opts.env, 0, true)
    .then((t) => {
      if (t == null) return null;
      try { return JSON.parse(t); } catch (e) { return null; }
    });
}

module.exports = {
  firstEnv, pickProxyEnv, parseProxyUrl, parseNoProxy, shouldBypassProxy, resolveProxy,
  openProxyTunnel, fetchTextProxy, fetchJsonProxy, requestText,
  PROXY_ENV_KEYS_HTTPS, PROXY_ENV_KEYS_HTTP, NO_PROXY_ENV_KEYS,
};
