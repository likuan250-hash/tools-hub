// ── 夸克网盘分享页「总大小」抓取 ──
// 参照 netdisk-hub/src/quark.js 重写，独立运行、不依赖 netdisk-hub 任何文件。
// 关键结论（已实测）：夸克网盘接口【无需签名】，仅需登录 Cookie 即可调用：
//   POST /1/clouddrive/share/sharepage/token  → 拿 stoken
//   GET  /1/clouddrive/share/sharepage/detail → 拿文件列表（顶层若是文件夹 size=0，必须递归）
// 总大小 = 递归汇总所有文件的 size 字段之和。
//
// Cookie 来源优先级：
//   1) 环境变量 QUARK_COOKIE（用户自填，最优先）
//   2) 只读读取 netdisk-hub 的 data/store.json 中 accounts.quark.cookie
//      （netdisk-hub 已用 Playwright 登录，kdocs-tool 复用其会话 → 零配置）
//   3) 都没有 → 返回 null，上层静默回退「手动填写」

const fs = require("fs");
const path = require("path");

const BASE = "https://drive-pc.quark.cn/1/clouddrive";

function qp(extra = {}) {
  const p = new URLSearchParams({
    pr: "ucpro",
    fr: "pc",
    uc_param_str: "",
    __dt: String(Math.floor(100 + Math.random() * 9899)),
    __t: String(Date.now()),
  });
  for (const k in extra) p.set(k, extra[k]);
  return p;
}

function headers(cookie) {
  return {
    Cookie: cookie,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Origin: "https://pan.quark.cn",
    Referer: "https://pan.quark.cn/",
  };
}

async function quarkFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000); // 单次请求 20s 上限，避免接口挂起无限等待
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const j = await res.json().catch(() => ({}));
    if (!j || typeof j.code === "undefined") {
      throw new Error("夸克接口返回异常: " + JSON.stringify(j).slice(0, 200));
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}

// ── Cookie 解析（只读，不写 netdisk-hub） ──
function getCookie() {
  const envCookie = (process.env.QUARK_COOKIE || "").trim();
  if (envCookie) return envCookie;
  try {
    const dataDir = process.env.NETDISK_DATA_DIR
      || (() => { const h = process.env.NETDISK_HUB_DIR || "E:\\工作空间\\netdisk-hub"; return path.join(h, "data"); })();
    const storePath = path.join(dataDir, "store.json");
    if (fs.existsSync(storePath)) {
      const d = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const acc = d.accounts && d.accounts.quark;
      if (acc && acc.cookie) return acc.cookie;
    }
  } catch (_) {
    /* 读取失败忽略，回退手动填写 */
  }
  return null;
}

function parseLink(link) {
  const s = (link || "").trim();
  const m = s.match(/pan\.quark\.cn\/s\/([A-Za-z0-9_-]+)/);
  const pwdId = m ? m[1] : s;
  let passcode = "";
  const pm = s.match(/[?&]pwd=([^&]+)/);
  if (pm) passcode = decodeURIComponent(pm[1]);
  return { pwdId, passcode };
}

async function getStoken(cookie, pwdId, passcode) {
  const url = `${BASE}/share/sharepage/token?${qp()}`;
  const j = await quarkFetch(url, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify({ pwd_id: pwdId, passcode: passcode || "" }),
  });
  if (j.code !== 0) throw new Error("获取分享凭证失败: " + (j.message || JSON.stringify(j)));
  return j.data.stoken;
}

async function fetchDetail(cookie, pwdId, stoken, pdirFid) {
  const params = qp({
    pwd_id: pwdId,
    stoken,
    pdir_fid: pdirFid,
    _page: "1",
    _size: "200",
    _fetch_total: "1",
  });
  const j = await quarkFetch(`${BASE}/share/sharepage/detail?${params}`, {
    headers: headers(cookie),
  });
  if (j.code !== 0) throw new Error("获取分享列表失败: " + (j.message || JSON.stringify(j)));
  return (j.data && j.data.list) || [];
}

// 递归求和文件 size（文件夹 size 常为 0，必须递归子目录）
async function walk(cookie, pwdId, stoken, pdirFid, seen, acc) {
  const list = await fetchDetail(cookie, pwdId, stoken, pdirFid);
  for (const it of list) {
    if (it.dir) {
      if (!seen.has(it.fid)) {
        seen.add(it.fid);
        await walk(cookie, pwdId, stoken, it.fid, seen, acc);
      }
    } else {
      acc.bytes += it.size || 0;
      acc.files += 1;
    }
  }
}

function formatSize(bytes) {
  if (!bytes) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  let s = v >= 100 ? v.toFixed(0) : v.toFixed(2);
  s = s.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  return s + units[u];
}

// ── 版本号选择：分享根目录含「游戏v1/ v2/ v3/」时，仅取最高版本求和 ──
// 取名称里最后一个 v?\d+(\.\d+)* 段，转整数元组便于比较
function parseVersion(name) {
  const m = (name || "").match(/v?\d+(?:\.\d+)*/gi);
  if (!m || m.length === 0) return null;
  const last = m[m.length - 1];
  return last.replace(/^v/i, "").split(".").map(Number);
}

function cmpVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 选出版本号最高的顶层条目（同版本分卷一起返回）；若所有条目都无版本号 → 返回空数组
function pickLatestVersion(list) {
  let best = null;
  let items = [];
  for (const it of list) {
    const v = parseVersion(it.file_name);
    if (!v) continue;
    if (!best) { best = v; items = [it]; continue; } // 首个带版本的设为基础
    const c = cmpVersion(v, best);
    if (c > 0) { best = v; items = [it]; }       // 更高版本 → 替换
    else if (c === 0) { items.push(it); }          // 同版本多个（如分卷 part1/part2）一起算
  }
  return items;
}

/**
 * 抓取夸克分享页总大小。
 * @param {string} link 夸克分享链接
 * @returns {Promise<{bytes:number,text:string,files:number}|null>}
 *   成功返回 {bytes,text(如 "30.7GB"),files}；无 Cookie / 失败 / 分享为空返回 null
 *   版本感知：根目录含多个版本文件夹时，仅对最高版本递归求和（扁平结构：根=版本）。
 */
async function getTotalSize(link) {
  const cookie = getCookie();
  if (!cookie) return null;
  const { pwdId, passcode } = parseLink(link);
  if (!pwdId) return null;
  // 整体预算上限 60s：超大分享(上千文件夹)递归求和也能在时限内结束，避免流程卡死
  const work = (async () => {
    const stoken = await getStoken(cookie, pwdId, passcode);
    // 先取顶层列表，按版本号选最新版；无版本号（如扁平无版本或嵌套）则回退全部
    const top = await fetchDetail(cookie, pwdId, stoken, "0");
    let targets = pickLatestVersion(top);
    if (targets.length === 0) targets = top;
    const acc = { bytes: 0, files: 0 };
    const seen = new Set();
    for (const t of targets) {
      if (t.dir) await walk(cookie, pwdId, stoken, t.fid, seen, acc);
      else { acc.bytes += t.size || 0; acc.files += 1; }
    }
    return { bytes: acc.bytes, text: formatSize(acc.bytes), files: acc.files };
  })();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("夸克大小抓取超时（60s）")), 60000));
  return Promise.race([work, timeout]);
}

module.exports = { getTotalSize, getCookie, parseLink, formatSize, BASE, parseVersion, pickLatestVersion };
