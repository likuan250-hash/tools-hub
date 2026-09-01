// src/baidu.js
// 百度网盘接入(网页端接口逆向,非开放平台 API)。
//
// 接口基线(取自活跃维护的 GitHub 项目 hxz393/BaiduPanFilesTransfers, 2025-09 仍更新):
//   bdstoken     : GET  /api/gettemplatevariable?app_id=38824127&fields=["bdstoken",...]
//   验证提取码   : POST /share/verify?surl=<去1>&bdstoken=&...  返回 randsk → 写入 BDCLND cookie
//   取转存参数   : GET  <分享链接>(带 BDCLND cookie) → 从 HTML 正则解析 shareid / share_uk / fs_id
//   转存         : POST /share/transfer?shareid=&from=share_uk&bdstoken=  body: fsidlist, path
//   生成我的分享 : POST /share/set?bdstoken=&app_id=250528          body: fid_list=[fs_id], period, pwd
//   目录检查/创建: GET  /api/list?dir=&bdstoken= | POST /api/create?a=commit&bdstoken=
//
// 注意:百度老的 /share/api?method=list|transfer|create 整族已 404 下线,切勿再用。
// 关键:所有请求必须带 Referer/Host/Sec-Fetch-* 等反爬头(对齐原版),否则 /share/transfer 返回 errno:2。
const store = require("./store");

const OAUTH_BASE = "https://openapi.baidu.com/oauth/2.0";
const PAN = "https://pan.baidu.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
// 对齐原版 HEADERS(Referer/Host/Sec-Fetch 是 /share/transfer 能跑通的关键)
const BASE_HEADERS = {
  Host: "pan.baidu.com",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
  "Sec-Fetch-Site": "same-site",
  "Sec-Fetch-Mode": "navigate",
  Referer: "https://pan.baidu.com",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7,en-GB;q=0.6,ru;q=0.5",
  "User-Agent": UA,
};

function getConfig() {
  return {
    clientId: process.env.BAIDU_CLIENT_ID,
    clientSecret: process.env.BAIDU_CLIENT_SECRET,
    redirectUri: process.env.BAIDU_REDIRECT_URI || "http://localhost:3000/auth/baidu/callback",
    appDir: process.env.BAIDU_APP_DIR || "/apps/netdisk_hub",
  };
}

function authorizeUrl(state = "x") {
  const c = getConfig();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: "basic,netdisk",
    display: "tv",
    qrcode: "1",
    state,
  });
  return `${OAUTH_BASE}/authorize?${p.toString()}`;
}

async function exchangeCode(code) {
  const c = getConfig();
  const p = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.redirectUri,
  });
  const res = await fetch(`${OAUTH_BASE}/token?${p.toString()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("Token 换取失败: " + JSON.stringify(data));
  return data;
}

async function refresh(refreshToken) {
  const c = getConfig();
  const p = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await fetch(`${OAUTH_BASE}/token?${p.toString()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("刷新失败: " + JSON.stringify(data));
  return data;
}

// 百度转存不需要 OAuth access_token;有 BDUSS cookie 即可。保留以兼容 server 的"已授权"判定。
async function getValidToken() {
  const acc = store.getAccount("baidu");
  if (!acc) return null;
  if (acc.cookie) return acc.cookie; // 用 cookie 作为已连接标志
  if (acc.accessToken) return acc.accessToken;
  return null;
}

function parseSurl(link) {
  const s = (link || "").trim();
  const m = s.match(/[?&]surl=([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const m2 = s.match(/pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];
  return s;
}

// ── BDUSS 会话 cookie(由 Playwright 登录获取,见 baidu.auth.js) ──
function getCookie() {
  const acc = store.getAccount("baidu");
  return (acc && acc.cookie) || null;
}

// cookie jar: 清理并重组 Playwright 登录时抓到的完整 cookie 串, 并追加 BDCLND(verify 后追加)
// 关键发现: Playwright context.cookies() 偶尔会返回 name 为空或 value 为 "undefined" 的脏 cookie,
// 若直接拼进 Cookie 头会导致百度解析失败 → errno:-6(登录态失效)。
// 因此必须清理:过滤空 key / undefined value, trim 后统一用 "; " 重组。
// 清理后的完整 cookie 串(含 BDUSS/STOKEN/BAIDUID/PANPSC 等)最接近浏览器真实行为。
const cookieJar = {};
let cleanCookie = "";
function parseCleanCookie(cookieStr) {
  const jar = {};
  (cookieStr || "").split(";").forEach((part) => {
    const p = part.trim();
    if (!p) return;
    const eq = p.indexOf("=");
    if (eq === -1) return;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (!k || v === "undefined") return;
    jar[k] = v;
  });
  return jar;
}
function syncJar() {
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
  const jar = parseCleanCookie(getCookie());
  Object.assign(cookieJar, jar);
  cleanCookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
// 核心登录态白名单:百度 API 真正需要的 cookie。实测「发送完整 cookie(含 XFI/XFS/PANPSC 等其它子域/辅助 cookie)」
// 在部分账号、尤其是新设备/新浏览器会话下,会被百度风控判定为异常而返回 errno:-6(登录态失效);
// 只发核心登录态最稳。故全量请求 -6 时,自动退回「仅核心 cookie」重试。
const ESSENTIAL_COOKIES = [
  "BDUSS",
  "BDUSS_BFESS",
  "STOKEN",
  "STOKEN_BFESS",
  "BDCLND",
  "BAIDUID",
  "PANPSC",
];
function buildCookieHeader(minimal) {
  let header;
  if (minimal) {
    header = Object.keys(cookieJar)
      .filter((k) => ESSENTIAL_COOKIES.includes(k))
      .map((k) => `${k}=${cookieJar[k]}`)
      .join("; ");
  } else {
    header = cleanCookie;
  }
  if (cookieJar["BDCLND"] && !header.includes("BDCLND=")) {
    header = (header ? header + "; " : "") + `BDCLND=${cookieJar["BDCLND"]}`;
  }
  return header;
}
function cookieHeader() {
  return buildCookieHeader(false);
}
// 组合请求头:基础反爬头 + 当前会话 cookie(extra 可覆盖 Cookie,用于「仅核心 cookie」重试)
function reqHeaders(extra) {
  const h = Object.assign({}, BASE_HEADERS, extra || {});
  if (!h.Cookie) h.Cookie = cookieHeader();
  return h;
}

// bdstoken 缓存(5 分钟内复用,减少请求)
let cachedBdstoken = null;
let bdstokenTs = 0;
async function getBdstoken() {
  if (cachedBdstoken && Date.now() - bdstokenTs < 5 * 60 * 1000) return cachedBdstoken;
  const url = `${PAN}/api/gettemplatevariable?clienttype=0&app_id=38824127&web=1&fields=${encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]')}`;
  // 先全量 cookie 请求;errno=-6 时退回「仅核心 cookie」重试(部分账号/新设备会话下全量会被判异常)
  let data;
  try {
    const res = await fetch(url, { headers: reqHeaders() });
    data = await res.json();
    if (data.errno === -6) {
      const res2 = await fetch(url, { headers: reqHeaders({ Cookie: buildCookieHeader(true) }) });
      const data2 = await res2.json();
      if (data2.errno === 0 && data2.result && data2.result.bdstoken) {
        data = data2;
        console.warn("[baidu] 全量 cookie 触发 errno=-6,已自动退回「仅核心 cookie」模式并成功");
      }
    }
  } catch (e) {
    throw new Error("获取 bdstoken 网络错误: " + e.message);
  }
  if (data.errno !== 0 || !data.result || !data.result.bdstoken) {
    let hint = "";
    if (data.errno === -6) {
      // 仅打印会话凭证「名称」(不打印值,避免泄露),便于确认是否抓到完整登录态 cookie
      const names = Object.keys(cookieJar).filter((k) =>
        /^(BDUSS|STOKEN|BDCLND|BAIDUID|PANPSC|PTOKEN|HOSUPPORT)/.test(k),
      );
      const hasBduss = !!(cookieJar["BDUSS"] || cookieJar["BDUSS_BFESS"]);
      const hasStoken = !!(cookieJar["STOKEN"] || cookieJar["STOKEN_BFESS"]);
      hint =
        `（百度登录态失效 errno=-6。已发核心凭证 BDUSS=${hasBduss ? "有" : "无"} STOKEN=${hasStoken ? "有" : "无"}; ` +
        `全部登录态 cookie 名称: ${names.join(",") || "无"}；` +
        `请重新点「授权百度网盘」完成扫码/账号登录,等看到网盘文件列表后再关闭窗口）`;
    }
    throw new Error("获取 bdstoken 失败 errno=" + data.errno + hint);
  }
  cachedBdstoken = data.result.bdstoken;
  bdstokenTs = Date.now();
  return cachedBdstoken;
}

// 用「给定 cookie 串」直接验证百度会话是否真的可用(登录时校验用,避免存进无效 cookie 导致假"已连接")。
// 先清理脏 cookie, 再用完整有效 cookie 串请求;若全量 -6 则退回「仅核心 cookie」重试(同 getBdstoken 策略)。
async function verifyCookie(cookieStr) {
  const jar = parseCleanCookie(cookieStr);
  const headerFull = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (!headerFull) return { ok: false, errno: "no_cookie" };
  const tryOnce = async (header) => {
    try {
      const fields = encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]');
      const url = `${PAN}/api/gettemplatevariable?clienttype=0&app_id=38824127&web=1&fields=${fields}&_t=${Date.now()}`;
      const res = await fetch(url, {
        headers: Object.assign({}, BASE_HEADERS, { Cookie: header }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { ok: data.errno === 0 && !!(data.result && data.result.bdstoken), errno: data.errno };
    } catch (e) {
      return { ok: false, errno: "net_error:" + (e.name || e.message || "unknown") };
    }
  };
  let r = await tryOnce(headerFull);
  // 全量 -6 → 退回「仅核心 cookie」重试
  if (!r.ok && r.errno === -6) {
    const headerMin = Object.entries(jar)
      .filter(([k]) => ESSENTIAL_COOKIES.includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const r2 = await tryOnce(headerMin);
    if (r2.ok) return { ok: true, errno: r2.errno, minimal: true };
    r = r2;
  }
  return r;
}

// 验证提取码,返回并写入 BDCLND cookie
async function verify(surl, pwd, bdstoken) {
  const qs = new URLSearchParams({
    surl,
    bdstoken,
    t: String(Date.now()),
    channel: "chunlei",
    web: "1",
    clienttype: "0",
  });
  const res = await fetch(`${PAN}/share/verify?${qs}`, {
    method: "POST",
    headers: reqHeaders({
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${PAN}/share/init?surl=${surl}`,
    }),
    body: new URLSearchParams({ pwd, vcode: "", vcode_str: "" }).toString(),
  });
  const data = await res.json();
  if (data.errno !== 0)
    throw new Error("提取码错误(errno=" + data.errno + "),请确认分享提取码是否正确");
  if (data.randsk) cookieJar["BDCLND"] = data.randsk;
  return data.randsk;
}

// 从分享页 HTML 解析出转存所需的 shareid / share_uk / fs_id 列表
// 注意：允许逗号/冒号后可选空白，避免分享页 HTML 非压缩（带空格）时静默解析失败。
const SHARE_ID_RE = /"shareid":\s*(\d+?)\s*,/;
const SHARE_UK_RE = /"share_uk":\s*"(\d+?)"\s*,/;
const FS_ID_RE = /"fs_id":(\d+?),/g;
const NAME_RE = /"server_filename":"(.+?)",/g;
// 取单个对象段内的 server_filename(非全局,用于按 fs_id 片段配对,避免受外层分享标题干扰)
const NAME_ONCE_RE = /"server_filename":"((?:[^"\\]|\\.)*?)"/;

async function getShareList(surl, pwd) {
  if (!getCookie()) throw new Error("百度尚未登录(BDUSS),请先点击「授权百度网盘」完成本机登录");
  syncJar();
  const bdstoken = await getBdstoken();

  // surl 去掉开头的 '1'(百度规范:pan.baidu.com/s/1xxx 内部 surl=xxx)
  const s = surl.startsWith("1") ? surl.slice(1) : surl;

  if (pwd) await verify(s, pwd, bdstoken);

  // GET 分享链接(带 BDCLND cookie),从 HTML 解析参数
  const link = `${PAN}/s/${surl}`;
  const res = await fetch(link, { headers: reqHeaders() });
  const html = await res.text();

  const shareid = (html.match(SHARE_ID_RE) || [])[1];
  const uk = (html.match(SHARE_UK_RE) || [])[1];
  // 按 fs_id 出现顺序提取,每个 fs_id 在其自身对象片段(到下一个 fs_id 之前)内取
  // 第一个 server_filename —— 避免外层分享标题污染、以及两数组下标整体错位导致文件名配错。
  const fsIdMatches = [...html.matchAll(FS_ID_RE)];
  const list = fsIdMatches.map((m, i) => {
    const fs_id = m[1];
    const start = m.index;
    const end = i + 1 < fsIdMatches.length ? fsIdMatches[i + 1].index : html.length;
    const seg = html.slice(start, end);
    const nm = seg.match(NAME_ONCE_RE);
    return { fs_id, server_filename: nm ? nm[1] : "", size: 0 };
  });

  if (!shareid || !uk || !list.length) {
    throw new Error(
      '未能从分享页解析出文件列表(可能链接是分享者主页而非文件分享,或需先点"提取文件";或 Cookie/BDUSS 已失效)',
    );
  }

  return { list, shareid, uk };
}

// 转存到我的网盘(目标目录 destPath)
async function transfer(shareid, uk, fsidList, destPath) {
  if (!getCookie()) throw new Error("百度尚未登录(BDUSS),无法转存");
  const bdstoken = await getBdstoken();
  const qs = new URLSearchParams({
    shareid: String(shareid),
    from: String(uk),
    bdstoken,
    channel: "chunlei",
    web: "1",
    clienttype: "0",
  });
  const body = new URLSearchParams({ fsidlist: JSON.stringify(fsidList), path: destPath });
  const res = await fetch(`${PAN}/share/transfer?${qs}`, {
    method: "POST",
    headers: reqHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: body.toString(),
  });
  const data = await res.json();
  // errno 0=成功, 4=目录已存在同名文件(实际已转存成功), 12=文件已存在(视作成功)
  if (data.errno !== 0 && data.errno !== 4 && data.errno !== 12)
    throw new Error("转存失败 errno=" + data.errno + " " + JSON.stringify(data).slice(0, 160));
  const file_list = (data.file_list || []).map((f) => ({
    fs_id: f.fs_id,
    path: f.path,
    server_filename: f.server_filename,
    size: f.size,
  }));
  const duplicated = ((data.duplicated && data.duplicated.list) || []).map((f) => ({
    fs_id: f.fs_id,
    path: f.path,
    server_filename: f.server_filename,
    size: f.size,
  }));
  return {
    file_list: file_list.concat(duplicated),
    task_id: data.task_id,
    errno: data.errno,
  };
}

// 确保转存目标目录存在(幂等):GET /api/list 检查,不存在则 POST /api/create
async function ensureDir(destPath) {
  const bdstoken = await getBdstoken();
  const lp = new URLSearchParams({
    order: "time",
    desc: "1",
    showempty: "0",
    web: "1",
    page: "1",
    num: "1000",
    dir: destPath,
    bdstoken,
  });
  const fl = await fetch(`${PAN}/api/list?${lp}`, { headers: reqHeaders() });
  const flj = await fl.json();
  if (flj.errno === 0) return { exists: true, created: false };
  const cp = new URLSearchParams({ a: "commit", bdstoken });
  const cr = await fetch(`${PAN}/api/create?${cp}`, {
    method: "POST",
    headers: reqHeaders(),
    body: new URLSearchParams({ path: destPath, isdir: "1", block_list: "[]" }).toString(),
  });
  const cj = await cr.json();
  if (cj.errno !== 0)
    throw new Error("创建转存目录失败 errno=" + cj.errno + " " + JSON.stringify(cj).slice(0, 120));
  return { exists: false, created: true };
}

// 列出指定目录下的文件/文件夹(返回 [{fs_id, server_filename, isdir, path}])
// 用于转存后解析"我盘内"的真实 fs_id(/share/set 必须用目标盘 fs_id,而非分享源 fs_id)
async function listDir(dirPath) {
  const bdstoken = await getBdstoken();
  const lp = new URLSearchParams({
    order: "time",
    desc: "1",
    showempty: "0",
    web: "1",
    page: "1",
    num: "1000",
    dir: dirPath,
    bdstoken,
  });
  const fl = await fetch(`${PAN}/api/list?${lp}`, { headers: reqHeaders() });
  const flj = await fl.json();
  if (flj.errno !== 0)
    throw new Error("列目录失败 errno=" + flj.errno + " " + JSON.stringify(flj).slice(0, 120));
  return (flj.list || []).map((f) => ({
    fs_id: f.fs_id,
    server_filename: f.server_filename,
    isdir: f.isdir,
    path: f.path,
    server_mtime: f.server_mtime,
  }));
}

// 聚合搜索:列出指定目录第一层,按关键词过滤(不递归)
async function searchFiles(dirPath, keyword) {
  const kw = String(keyword || "")
    .trim()
    .toLowerCase();
  if (!kw) return [];
  const list = await listDir(dirPath || "/");
  return list
    .filter((f) => f.server_filename.toLowerCase().includes(kw))
    .map((f) => ({
      id: String(f.fs_id),
      name: f.server_filename,
      isdir: f.isdir === 1,
      size: f.size || 0,
      time: f.server_mtime ? f.server_mtime * 1000 : 0,
    }));
}

// 删除到回收站(软删,可恢复);async=2 异步执行
async function trashFiles(fsIds) {
  if (!fsIds || !fsIds.length) throw new Error("删除失败:缺少文件 fs_id");
  const bdstoken = await getBdstoken();
  const qs = new URLSearchParams({
    opera: "delete",
    async: "2",
    bdstoken,
    channel: "chunlei",
    web: "1",
    clienttype: "0",
  });
  const body = new URLSearchParams({ filelist: JSON.stringify(fsIds.map(Number)) });
  const res = await fetch(`${PAN}/api/filemanager?${qs}`, {
    method: "POST",
    headers: reqHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: body.toString(),
  });
  const j = await res.json();
  if (j.errno !== 0)
    throw new Error("百度删除失败 errno=" + j.errno + " " + JSON.stringify(j).slice(0, 160));
  return j;
}

// 列出某目录下的「子文件夹」(供网页端目录选择器浏览树使用)
// dirPath 根目录传 '/' ;返回 [{id: 完整路径, name: 文件夹名}]
async function listSubfolders(dirPath) {
  const list = await listDir(dirPath || "/");
  return list.filter((f) => f.isdir === 1).map((f) => ({ id: f.path, name: f.server_filename }));
}

// 百度分享提取码固定为 8888(用户要求:所有百度分享都用此码,且链接内嵌 ?pwd=8888 一点即达)。
// 百度 /share/set 要求非空提取码(空串报 pwd length param error)。
const DEFAULT_SHARE_PWD = "8888";

// 生成我的分享链接(fid_list 为我盘里文件的 fs_id 列表)
// 返回的 link 直接拼接 ?pwd=XXXX,百度前端打开该链接会自动填充提取码,实现"一点即达"。
async function createShare(fsIdList, period, password) {
  if (!fsIdList || !fsIdList.length) throw new Error("生成分享失败:缺少文件 fs_id");
  if (!getCookie()) throw new Error("百度尚未登录(BDUSS),无法生成分享链接");
  const bdstoken = await getBdstoken();
  const qs = new URLSearchParams({
    channel: "chunlei",
    bdstoken,
    clienttype: "0",
    app_id: "250528",
    web: "1",
  });
  const body = new URLSearchParams();
  body.set("period", String(period || 0));
  body.set("eflag_disable", "true");
  body.set("channel_list", "[]");
  body.set("schannel", "4");
  body.set("fid_list", JSON.stringify(fsIdList));
  // 提取码固定 8888(传入的 password 为空/无效时回退到默认值)
  const pwd = (password && String(password).trim()) || DEFAULT_SHARE_PWD;
  body.set("pwd", pwd);
  const res = await fetch(`${PAN}/share/set?${qs}`, {
    method: "POST",
    headers: reqHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: body.toString(),
  });
  const data = await res.json();
  if (data.errno !== 0)
    throw new Error("生成分享失败 errno=" + data.errno + " " + JSON.stringify(data).slice(0, 160));
  const rawLink = data.link || "";
  const baiduShareRe = /^(https?:\/\/)?pan\.baidu\.com\/s\/[A-Za-z0-9_-]{5,}$/;
  // 去掉 query 后再做格式校验
  const rawLinkNoQs = rawLink.split("?")[0].split("#")[0];
  if (!baiduShareRe.test(rawLinkNoQs)) {
    throw new Error("生成分享成功但返回链接不完整: " + JSON.stringify(data).slice(0, 240));
  }
  // link 内嵌提取码:打开即自动填码,免去手动复制粘贴
  const link = rawLink.includes("?") ? `${rawLink}&pwd=${pwd}` : `${rawLink}?pwd=${pwd}`;
  return { link, password: pwd, shareid: data.shareid };
}

// 轻量存活检查:直接请求模板变量接口(无需 bdstoken),cookie 失效将 errno≠0
// 该接口不受 getBdstoken 的 5 分钟缓存影响,能反映 cookie 真实有效性。
let lastCheckError = "";
async function checkSession() {
  syncJar();
  if (!cookieHeader()) {
    lastCheckError = "no_session_cookie";
    return false;
  }
  try {
    const fields = encodeURIComponent('["bdstoken","token","uk","isdocuser","servertime"]');
    const url = `${PAN}/api/gettemplatevariable?clienttype=0&app_id=38824127&web=1&fields=${fields}&_t=${Date.now()}`;
    const res = await fetch(url, { headers: reqHeaders(), signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    const ok = data.errno === 0 && !!(data.result && data.result.bdstoken);
    lastCheckError = ok ? "" : "baidu_errno_" + (data.errno == null ? "unknown" : data.errno);
    return ok;
  } catch (e) {
    lastCheckError = "net_error:" + (e.name || e.message || "unknown");
    return false;
  }
}

// 返回最近一次 checkSession 的失败原因(供前端诊断展示)
function getLastCheckError() {
  return lastCheckError;
}

module.exports = {
  getConfig,
  authorizeUrl,
  exchangeCode,
  getValidToken,
  getCookie,
  checkSession,
  getLastCheckError,
  verifyCookie,
  ensureDir,
  parseSurl,
  parseCleanCookie,
  getShareList,
  transfer,
  listDir,
  searchFiles,
  trashFiles,
  listSubfolders,
  createShare,
};
