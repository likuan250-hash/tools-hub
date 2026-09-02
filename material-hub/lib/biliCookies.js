// lib/biliCookies.js —— B站登录态解析（供 yt-dlp --cookies 使用）
//
// 背景（实测）：B站 对未登录请求直接返回 **HTTP 412**，yt-dlp 连视频页都拉不到，
// 因此「解析画质」与「下载」两步都必须带 cookie——不是只有高画质才需要登录。
//
// 登录态来源优先级：
//   1) material-hub/.bili-cookies.txt —— 用户手动放置的 Netscape 格式 cookie（最高优先，便于覆盖）
//   2) biliup-hub（B站自动投稿）的 cookies.json —— 复用 App 内已登录的 B站账号
//      · 位置：process.env.BILIUP_DATA_DIR 指向的目录（主进程 fork 子进程时注入，打包后 = userData/biliup-hub/data）
//      · 该文件是 AES-256-GCM 密文，解密复用 biliup-hub 自带的 lib/cookies.js + lib/crypto.js
//        （主密钥 userData/.masterkey 由 biliup 自己解析，这里不重复实现，避免两套密钥逻辑漂移）
//   3) 都没有 → 返回 null，调用方降级（yt-dlp 大概率 412，由上层提示去「B站自动投稿」重新登录）
//
// 跨模块说明：这里 require 了同仓库的 biliup-hub/lib/cookies.js。打包配置里 biliup-hub 与
// material-hub 同为 extraResources 平级目录，源码形式的 lib/ 均在包内（仅 data/ 被排除），
// 路径恒定。即便缺失或解密失败也只降级、不影响主流程（try/catch 全包）。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchJson } = require("./http");

const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
/** 用户手动放置的 Netscape cookie（仓库内，已被 .gitignore 忽略）。 */
const LOCAL_FILE = path.join(__dirname, "..", ".bili-cookies.txt");
/** 由 biliup 登录态临时导出的 Netscape cookie（系统临时目录，非仓库、不入 git）。 */
const TMP_FILE = path.join(os.tmpdir(), "tools-hub-bili-cookies.txt");
const CACHE_TTL = 10 * 60 * 1000;

/** 进程内缓存：{ file, source, at }；登录用户信息单独存 login 字段。 */
let _cache = null;
let _login = null;

/**
 * 把 {name: value} 形态的 cookie 转成 Netscape 格式文本（yt-dlp --cookies 只认这种格式）。
 * @param {Object} cookies 扁平 cookie 对象
 * @param {string} [domain] 作用域域名
 * @returns {string}
 */
function toNetscape(cookies, domain = ".bilibili.com") {
  const lines = ["# Netscape HTTP Cookie File"];
  // expiry 取 int32 上限：B站 的 SESSDATA 实际有效期由服务端判定，
  // 本地只要给一个"未过期"的值让 yt-dlp 愿意带上即可。
  const expiry = 2147483647;
  for (const name of Object.keys(cookies || {})) {
    const v = cookies[name];
    if (v == null || v === "") continue;
    lines.push([domain, "TRUE", "/", "FALSE", expiry, name, String(v)].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/**
 * 尝试加载 biliup-hub（B站自动投稿）的登录态。
 * @returns {{cookies: Object, file: string}|null} 失败（未安装/未登录/解密失败）返回 null
 */
function loadBiliupCookies() {
  const dataDir = process.env.BILIUP_DATA_DIR;
  if (!dataDir || !String(dataDir).trim()) return null;
  const file = path.join(String(dataDir).trim(), "cookies.json");
  if (!fs.existsSync(file)) return null;
  const modPath = path.join(__dirname, "..", "..", "biliup-hub", "lib", "cookies.js");
  if (!fs.existsSync(modPath)) return null;
  try {
    // 注意：biliup 的 crypto 在 require 时就按 BILIUP_DATA_DIR 推导主密钥路径，
    // 因此必须在进程里已注入该 env 的前提下加载（打包后由主进程注入）。
    const cookies = require(modPath);
    const parsed = cookies.load(file);
    if (!cookies.validate(parsed)) return null;
    return { cookies: parsed, file };
  } catch (e) {
    return null;
  }
}

/**
 * 解析出可用的 Netscape cookie 文件（不存在则 tmp 落盘一份）。
 * @param {{force?: boolean}} [opts] force=true 忽略进程内缓存
 * @returns {{file: string, source: "local"|"biliup"}|null} 无登录态时返回 null
 */
function resolveCookieFile(opts = {}) {
  const now = Date.now();
  if (!opts.force && _cache && now - _cache.at < CACHE_TTL) {
    return { file: _cache.file, source: _cache.source };
  }

  // 1) 手动放置优先
  if (fs.existsSync(LOCAL_FILE)) {
    try {
      const txt = fs.readFileSync(LOCAL_FILE, "utf8");
      if (/SESSDATA/i.test(txt)) {
        _cache = { file: LOCAL_FILE, source: "local", at: now };
        return { file: LOCAL_FILE, source: "local" };
      }
    } catch (e) {
      /* 读失败继续走下一个来源 */
    }
  }

  // 2) 复用 biliup-hub 登录态
  const biliup = loadBiliupCookies();
  if (biliup) {
    try {
      fs.writeFileSync(TMP_FILE, toNetscape(biliup.cookies), { mode: 0o600 });
      _cache = { file: TMP_FILE, source: "biliup", at: now };
      return { file: TMP_FILE, source: "biliup" };
    } catch (e) {
      /* 写临时文件失败 → 降级 */
    }
  }

  _cache = null;
  return null;
}

/**
 * 校验登录态是否有效，并返回用户信息（调 B站 nav 接口）。
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, uname?: string, source?: "local"|"biliup"|null, error?: string}>}
 */
async function getLoginInfo(opts = {}) {
  if (!opts.force && _login && Date.now() - _login.at < CACHE_TTL) {
    return { ok: _login.ok, uname: _login.uname, source: _login.source };
  }
  const resolved = resolveCookieFile(opts);
  if (!resolved) {
    _login = { ok: false, uname: "", source: null, at: Date.now() };
    return { ok: false, uname: "", source: null, error: "未找到 B站登录态" };
  }
  try {
    const header = fs
      .readFileSync(resolved.file, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const cols = l.split("\t");
        return cols.length >= 7 ? cols[5] + "=" + cols[6] : "";
      })
      .filter(Boolean)
      .join("; ");
    const r = await fetchJson(NAV_URL, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://www.bilibili.com/",
        Cookie: header,
      },
    });
    const data = (r.json && r.json.data) || {};
    const ok = r.json && r.json.code === 0 && data.isLogin === true;
    _login = { ok: !!ok, uname: data.uname || "", source: resolved.source, at: Date.now() };
    return { ok: !!ok, uname: data.uname || "", source: resolved.source };
  } catch (e) {
    // 网络异常不应阻断下载流程：登录态未知时按"未登录"处理，由上层决定是否提示
    _login = { ok: false, uname: "", source: resolved.source, at: Date.now() };
    return { ok: false, uname: "", source: resolved.source, error: e.message };
  }
}

module.exports = { resolveCookieFile, getLoginInfo, toNetscape, NAV_URL };
