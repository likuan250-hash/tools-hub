// src/xunlei.js
// 迅雷网盘接入(第四阶段 · 纯 HTTP API 方案)。
//
// ✅ 2026-07-21 重构:彻底抛弃脆弱的 Playwright UI 点击方案(DOM 点击进子目录、
//    请求拦截改 parent_id、轮询卡 3 分钟),改为直接调迅雷 **官方私有 API**:
//        api-pan.xunlei.com/drive/v1/...
//    借鉴开源项目 wgx0307/netdisk(xunlei.go)的接口结构 + 本地实测的 token 读取方式。
//
// 架构要点:
//   ① 鉴权:tokens 全部从已登录浏览器 profile 的 localStorage 读取
//      - access_token / refresh_token : localStorage['credentials_Xqp0kJBXWhwaTpB6']
//      - device_id                   : localStorage['deviceid']
//      - captcha_token               : localStorage['captcha_Xqp0kJBXWhwaTpB6'].token
//      client_id 固定为 Xqp0kJBXWhwaTpB6(迅雷网页版前端固定值)。
//   ② access_token 约 3h 过期;过期用 refresh_token 调 xluser-ssl.xunlei.com/v1/auth/token 换新。
//   ③ captcha_token 不能离线算(硬编码的 captcha_sign 已被迅雷作废),直接复用 localStorage 里的;
//      失效时由 Playwright 打开页面让 SPA 自动刷新(重新 loadTokensFromProfile)。
//   ④ Playwright 仅在「读 token / 重新登录」时使用,正常转存全程纯 HTTP(快、稳)。

const store = require("./store");
const fs = require("fs");
const path = require("path");

// Playwright 仅在需要启动真实浏览器（读 token / 重新登录）时才加载，
// 避免「仅调用解析函数」时也强制依赖 playwright 模块，提升启动速度，
// 并让解析函数的单元测试可在无浏览器环境下运行。
let _playwright = null;
function getChromium() {
  if (!_playwright) _playwright = require("playwright");
  return _playwright.chromium;
}

// 登录态目录：同 store.js，优先 NETDISK_DATA_DIR(升级不丢)，否则回退安装目录 data/。
const STORAGE_DIR = path.join(
  process.env.NETDISK_DATA_DIR || path.join(__dirname, "..", "data"),
  "xunlei_profile",
);
const CLIENT_ID = "Xqp0kJBXWhwaTpB6";
const API_BASE = "https://api-pan.xunlei.com/drive/v1";
const AUTH_BASE = "https://xluser-ssl.xunlei.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const ORIGIN = "https://pan.xunlei.com";

// 内存 token 缓存(避免每次转存都起浏览器)
let tokenCache = { access_token: "", refresh_token: "", device_id: "", captcha: "", expires_at: 0 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 启动时尝试从 store 恢复缓存的 token(不启浏览器)
(function restoreFromStore() {
  try {
    const acc = store.getAccount("xunlei") || {};
    if (acc.tokens && acc.tokens.access_token) {
      tokenCache = { ...tokenCache, ...acc.tokens };
    }
  } catch (_) {}
})();

function persistTokens() {
  try {
    const acc = store.getAccount("xunlei") || {};
    store.saveAccount("xunlei", { ...acc, tokens: { ...tokenCache } });
  } catch (_) {}
}

// 从持久化 profile 读 localStorage 里的全部 token(Playwright 打开页面,SPA 会自动刷新过期的 token/captcha)。
async function loadTokensFromProfile() {
  // 用 headless:true + 窗口外置参数,确保 Windows 上也不闪现黑框。
  // persistent context 在部分 Chromium 版本下仍会创建可见窗口,
  // 移出屏幕(-10000,-10000) + 1x1 尺寸 + start-minimized 可彻底隐藏。
  const context = await getChromium().launchPersistentContext(STORAGE_DIR, {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateWindowOcclusion",
      "--window-position=-10000,-10000",
      "--window-size=1,1",
      "--start-minimized",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-notifications",
    ],
  });
  try {
    const page = await context.newPage();
    await page
      .goto(ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 25000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    const t = await page.evaluate(() => {
      let c = {};
      try {
        c = JSON.parse(localStorage.getItem("credentials_Xqp0kJBXWhwaTpB6") || "{}");
      } catch (e) {}
      let cap = "";
      try {
        cap = JSON.parse(localStorage.getItem("captcha_Xqp0kJBXWhwaTpB6") || "{}").token || "";
      } catch (e) {}
      return {
        access_token: c.access_token || "",
        refresh_token: c.refresh_token || "",
        device_id: localStorage.getItem("deviceid") || "",
        captcha: cap,
        expires_at: c.expires_at || 0,
      };
    });
    tokenCache = { ...tokenCache, ...t };
    persistTokens();
    return t;
  } finally {
    await context.close();
  }
}

// 刷新 token:优先用 refresh_token 纯 HTTP 换新;失败/强制则重新读 profile(SPA 自动刷新)。
async function refreshTokens(force) {
  if (tokenCache.refresh_token && !force) {
    try {
      const r = await fetch(AUTH_BASE + "/v1/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA, Origin: ORIGIN + "/" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: tokenCache.refresh_token,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.access_token) {
        tokenCache.access_token = j.access_token;
        if (j.refresh_token) tokenCache.refresh_token = j.refresh_token;
        if (j.expires_at) tokenCache.expires_at = j.expires_at;
        else if (j.expires_in) tokenCache.expires_at = Date.now() + j.expires_in * 1000;
        persistTokens();
        return;
      }
    } catch (_) {}
  }
  await loadTokensFromProfileGuarded();
}

// 刷新单飞(singleflight):并发的刷新/401 重试只真正执行一次刷新,
// 其余复用同一 Promise,避免批量 401 时同时拉起多个 headless 浏览器刷新导致互相干扰/雪崩。
let refreshPromise = null;
async function refreshTokensGuarded(force) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      await refreshTokens(force);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// 读 profile 单飞:并发转存时若都需要从浏览器读 token,只真正启动一次浏览器,
// 避免多个黑框同时闪烁/互相争抢 profile。
let profileLoadPromise = null;
async function loadTokensFromProfileGuarded() {
  if (profileLoadPromise) return profileLoadPromise;
  profileLoadPromise = (async () => {
    try {
      return await loadTokensFromProfile();
    } finally {
      profileLoadPromise = null;
    }
  })();
  return profileLoadPromise;
}

// 获取一组有效的请求鉴权参数 {token, captcha, deviceId}。
async function getValidAuth() {
  const now = Date.now();
  const expiring = tokenCache.expires_at && tokenCache.expires_at < now + 5 * 60 * 1000;
  if (!tokenCache.access_token || expiring) {
    if (tokenCache.refresh_token) await refreshTokensGuarded(false);
    else await loadTokensFromProfileGuarded();
  }
  if (!tokenCache.access_token) {
    throw new Error("迅雷未授权:请先点击「授权迅雷网盘」完成本机登录");
  }
  return {
    token: tokenCache.access_token,
    captcha: tokenCache.captcha,
    deviceId: tokenCache.device_id,
  };
}

// 通用 API 调用,自动注入鉴权头;遇 401/403 自动刷新并重试一次。
async function apiCall(method, url, { query, body, _depth = 0 } = {}) {
  const auth = await getValidAuth();
  let u = url;
  if (query) u += (url.includes("?") ? "&" : "?") + new URLSearchParams(query).toString();
  const headers = {
    Authorization: "Bearer " + auth.token,
    "x-captcha-token": auth.captcha,
    "x-client-id": CLIENT_ID,
    "x-device-id": auth.deviceId,
    Origin: ORIGIN,
    Referer: ORIGIN + "/",
    "User-Agent": UA,
    Accept: "*/*",
  };
  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(u, opts);
  const txt = await resp.text();
  let j = null;
  try {
    j = JSON.parse(txt);
  } catch (e) {}
  const isCaptchaInvalid =
    resp.status === 400 && j && (j.error === "captcha_invalid" || j.error_code === 9);
  if ((resp.status === 401 || resp.status === 403 || isCaptchaInvalid) && _depth === 0) {
    // token 或 captcha 失效 → 强制刷新(重新读 profile 让 SPA 刷新 captcha)并重试
    await refreshTokensGuarded(true);
    return apiCall(method, url, { query, body, _depth: 1 });
  }
  return { status: resp.status, json: j, text: txt };
}

// ── 业务 API ──

// 列目录(parent_id 空=根目录)。files 在响应顶层。
// 翻页:limit 固定 50,按 next_page_token 累加,避免根目录超 50 项时找不到目标目录。
async function listFiles(parentId) {
  let all = [];
  let pageToken = "";
  let pages = 0;
  do {
    const query = {
      parent_id: parentId || "",
      filters: '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}',
      with_audit: "true",
      thumbnail_size: "SIZE_SMALL",
      limit: "50",
    };
    if (pageToken) query.page_token = pageToken;
    const r = await apiCall("GET", API_BASE + "/files", { query });
    if (r.status !== 200)
      throw new Error("列目录失败(" + r.status + "): " + (r.text || "").slice(0, 200));
    const files = (r.json && r.json.files) || [];
    all = all.concat(
      files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        kind: f.kind,
        type: f.type,
        time: f.modified_time || f.created_time || "",
      })),
    );
    pageToken = (r.json && (r.json.next_page_token || r.json.nextPageToken)) || "";
  } while (pageToken && ++pages < 200); // 200 页上限防止异常死循环
  return all;
}

// 聚合搜索:列出指定目录第一层,按关键词过滤(不递归)
async function searchFiles(parentId, keyword) {
  const kw = String(keyword || "")
    .trim()
    .toLowerCase();
  if (!kw) return [];
  const files = await listFiles(parentId || "");
  return files
    .filter((f) => f.name.toLowerCase().includes(kw))
    .map((f) => ({
      id: f.id,
      name: f.name,
      isdir: /folder/i.test(f.kind || ""),
      size: f.size || 0,
      time: f.time,
    }));
}

// 删除到回收站(软删,可恢复)
async function trashFiles(ids) {
  if (!ids || !ids.length) throw new Error("删除失败:缺少文件 id");
  const r = await apiCall("POST", API_BASE + "/files:batchDelete", {
    body: { ids: ids.map(String), space: "" },
  });
  if (r.status !== 200) {
    throw new Error("迅雷删除失败(" + r.status + "): " + (r.text || "").slice(0, 200));
  }
  return r.json || {};
}

// 找目录:仅精确匹配(名称完全相等且为文件夹,或名称完全相等)。
// 去掉「包含匹配」兜底,避免「游戏合集」「游戏音乐」等被误当「游戏」目录导致转存到错误位置。
async function findFolder(name, parentId) {
  const files = await listFiles(parentId || "");
  const hit =
    files.find((x) => x.name === name && /folder/i.test(x.kind || "")) ||
    files.find((x) => x.name === name);
  return hit ? { id: hit.id, name: hit.name } : null;
}

// 列出某目录下的「子文件夹」(供网页端目录选择器浏览树使用)
// parentId 根目录传 '';返回 [{id, name}]
async function listSubfolders(parentId) {
  const files = await listFiles(parentId || "");
  return files.filter((f) => /folder/i.test(f.kind || "")).map((f) => ({ id: f.id, name: f.name }));
}

// 创建文件夹(调用方需先 findFolder 确认不存在,否则会报「已存在」类错误)。
// XunLei 的 drive/v1/files 创建接口:kind 区分文件/文件夹,drive#folder 即目录。
// 返回 {id, name}。
async function createFolder(name, parentId) {
  const r = await apiCall("POST", API_BASE + "/files", {
    body: {
      parent_id: parentId || "",
      name: name,
      kind: "drive#folder",
    },
  });
  if (r.status !== 200) {
    throw new Error("创建迅雷文件夹失败(" + r.status + "): " + (r.text || "").slice(0, 240));
  }
  const d = r.json || {};
  const folder = d.file || d; // 迅雷把新目录包在 file 字段下
  if (!folder.id) throw new Error("创建迅雷文件夹未返回 id: " + (r.text || "").slice(0, 240));
  return { id: folder.id, name: folder.name || name };
}

// 取他人分享的文件列表 + pass_code_token。
async function getShareInfo(shareId, pwd) {
  const r = await apiCall("GET", API_BASE + "/share", {
    query: {
      share_id: shareId,
      pass_code: pwd || "",
      limit: "100",
      pass_code_token: "",
      page_token: "",
      thumbnail_size: "SIZE_SMALL",
    },
  });
  const data = (r.json && (r.json.data || r.json)) || {};
  const status = r.json && (r.json.share_status || data.share_status);
  if (status && status !== "OK")
    throw new Error("分享无效(" + status + "):" + (r.text || "").slice(0, 200));
  const files = data.files || [];
  if (!files.length) throw new Error("该分享为空或无法读取文件列表(可能需重新登录)");
  return {
    files: files.map((f) => ({ id: f.id, name: f.name, size: f.size })),
    passCodeToken: data.pass_code_token || "",
  };
}

// 转存到指定目录(parent_id 直接指定,无需 UI 操作)。
async function restore(shareId, passCodeToken, fileIds, parentId) {
  const r = await apiCall("POST", API_BASE + "/share/restore", {
    body: {
      parent_id: parentId || "",
      share_id: shareId,
      pass_code_token: passCodeToken,
      ancestor_ids: [],
      specify_parent_id: true,
      file_ids: fileIds,
    },
  });
  if (r.status !== 200)
    throw new Error("转存失败(" + r.status + "): " + (r.text || "").slice(0, 200));
  const data = r.json || {};
  const taskId = data.restore_task_id || (data.data && data.data.restore_task_id);
  if (!taskId) throw new Error("转存未返回任务ID: " + (r.text || "").slice(0, 200));
  return taskId;
}

// 轮询转存任务,返回新文件 ID 列表。
async function waitTask(taskId) {
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const r = await apiCall("GET", API_BASE + "/tasks/" + taskId, {});
    if (r.json && r.json.progress === 100) {
      const params = r.json.params || {};
      const trace = params.trace_file_ids;
      if (trace) {
        try {
          return Object.values(JSON.parse(trace));
        } catch (e) {}
      }
    }
  }
  throw new Error("转存任务超时(未在60s内完成)");
}

// 生成我的分享链接(带提取码)。返回 {link, password, shareId}。
async function createShare(fileIds) {
  const r = await apiCall("POST", API_BASE + "/share", {
    body: {
      file_ids: fileIds,
      share_to: "copy",
      params: { subscribe_push: "false", WithPassCodeInLink: "true" },
      title: "云盘资源分享",
      restore_limit: "-1",
      expiration_days: "-1",
    },
  });
  if (r.status !== 200)
    throw new Error("创建分享失败(" + r.status + "): " + (r.text || "").slice(0, 200));
  const data = r.json || {};
  const sd = data.data || data;
  const url = sd.share_url || "";
  const xunleiShareRe = /^(https?:\/\/)?pan\.xunlei\.com\/s\/[A-Za-z0-9_-]{5,}$/;
  const urlNoQs = url.split("?")[0].split("#")[0];
  if (!xunleiShareRe.test(urlNoQs)) {
    throw new Error("生成分享成功但返回链接不完整: " + JSON.stringify(r.json).slice(0, 240));
  }
  const pwd = sd.pass_code || "";
  const link = url + (pwd ? "?pwd=" + pwd + "#" : "");
  return { link, password: pwd, shareId: sd.share_id };
}

// ── 对外的兼容导出 ──

function parseSurl(link) {
  const s = (link || "").trim();
  const m = s.match(/pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/);
  if (m) return "https://pan.xunlei.com/s/" + m[1];
  const m2 = s.match(/[?&]s=([A-Za-z0-9_-]+)/);
  if (m2) return "https://pan.xunlei.com/s/" + m2[1];
  if (/^[A-Za-z0-9_-]+$/.test(s)) return "https://pan.xunlei.com/s/" + s;
  return s;
}

function isConnected() {
  const acc = store.getAccount("xunlei");
  if (!(acc && acc.connected)) return false;
  if (tokenCache.access_token) return true;
  try {
    return fs.existsSync(STORAGE_DIR);
  } catch (e) {
    return false;
  }
}

// 测试用：注入有效鉴权令牌，跳过 Playwright 浏览器读取（不依赖浏览器即可跑 HTTP 接口层单测）。
// 生产代码不会调用；仅被 test 使用。
function setAuthForTest(auth) {
  tokenCache = Object.assign({}, tokenCache, auth || {});
  if (!tokenCache.expires_at) tokenCache.expires_at = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
}

async function pingSession() {
  // 纯探测: 不修改已保存的登录态(避免「探测失败」反向把 connected 写成 false 导致误判未连接)
  try {
    const files = await listFiles("");
    return Array.isArray(files);
  } catch (e) {
    return false;
  }
}

// 编排:取分享 → 找/用目标目录 → 转存(指定 parent_id) → 轮询 → 生成分享。
// 返回 { file_list, share, destPath, task_id } (兼容 server 期望)。
// destFolderId / destFolderName: 网页端用户选定的转存目录(优先于默认「游戏」与 .env)。
async function transfer({
  link,
  pwd,
  makeShare,
  sharePeriod,
  sharePassword,
  destFolderId,
  destFolderName,
}) {
  const surl = parseSurl(link);
  const m = surl.match(/pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("无法从链接解析迅雷分享ID");
  const shareId = m[1];
  const pass = pwd || (surl.match(/pwd=([^&]+)/) || [])[1] || "";

  const info = await getShareInfo(shareId, pass);
  const names = info.files.map((f) => f.name);

  // 确定转存目标目录优先级:
  //   1) 网页端用户选定 destFolderId(含空串=根目录) → 直接用;
  //   2) .env 显式配置 XUNLEI_DEST_FOLDER_ID → 直接用;
  //   3) 按名字「游戏」查找(已存在则跳过创建);
  //   4) 找不到则自动创建。
  let game;
  if (destFolderId !== null && destFolderId !== undefined) {
    game = { id: destFolderId, name: destFolderName || "游戏" };
  } else {
    const envFolderId = (process.env.XUNLEI_DEST_FOLDER_ID || "").trim();
    if (envFolderId) {
      game = { id: envFolderId, name: "游戏" };
    } else {
      game = await findFolder("游戏");
      if (!game) game = await createFolder("游戏", "");
    }
  }

  const taskId = await restore(
    shareId,
    info.passCodeToken,
    info.files.map((f) => f.id),
    game.id,
  );
  const fileList = info.files.map((f) => ({
    path: "/" + game.name + "/" + f.name,
    server_filename: f.name,
    size: f.size,
  }));

  let newFileIds = [];
  let waitError = null;
  try {
    newFileIds = await waitTask(taskId);
  } catch (e) {
    waitError = e.message;
  } // 轮询失败先记下,转存可能已成功但拿不到新 id

  let share = null;
  let shareError = null;
  if (makeShare) {
    if (!newFileIds.length) {
      shareError = waitError
        ? "转存任务未完成,无法生成分享:" + waitError
        : "转存任务未完成,无法生成分享";
    } else {
      try {
        share = await createShare(newFileIds);
      } catch (e) {
        shareError = e.message;
      }
    }
  }

  // 明确要求生成分享却失败 → 向上抛错,由 server 记 failed 并在前端报错,
  // 避免「静默 success 但没有分享链接」让使用者以为成功却什么都没拿到。
  if (makeShare && shareError) {
    throw new Error("分享生成失败:" + shareError);
  }

  return { file_list: fileList, share, destPath: "/" + game.name, task_id: taskId };
}

// 兼容旧导出(供调试/前端单独调用,内部均为纯 HTTP)
async function getShareList(shareUrl, pwd) {
  const m = (shareUrl || "").match(/s\/([A-Za-z0-9_-]+)/);
  const shareId = m ? m[1] : shareUrl;
  const info = await getShareInfo(shareId, pwd);
  return { list: info.files, raw: info };
}
async function saveShare(opts) {
  const m = (opts.shareUrl || "").match(/s\/([A-Za-z0-9_-]+)/);
  const shareId = m ? m[1] : opts.shareUrl;
  const info = await getShareInfo(shareId, opts.pwd);
  const taskId = await restore(
    shareId,
    info.passCodeToken,
    info.files.map((f) => f.id),
    opts.destId || "",
  );
  return { restore_task_id: taskId, task_id: taskId, destPath: "/" + (opts.destName || "") };
}

async function probeListRoot() {
  try {
    const files = await listFiles("");
    return { ok: true, count: files.length, sample: files.slice(0, 5) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  isConnected,
  pingSession,
  parseSurl,
  findFolder,
  createFolder,
  getShareInfo,
  restore,
  getShareList,
  saveShare,
  listFiles,
  searchFiles,
  trashFiles,
  listSubfolders,
  createShare,
  transfer,
  probeListRoot,
  loadTokensFromProfile: loadTokensFromProfileGuarded,
  setAuthForTest,
};
