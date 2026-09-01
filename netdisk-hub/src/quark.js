// 夸克网盘网页端接口封装(逆向,无官方 API)
// 基址: https://drive-pc.quark.cn/1/clouddrive
// 鉴权: Cookie(登录后从浏览器拿,本项目用 Playwright 登录后存库)
// 公共 query: pr=ucpro&fr=pc&uc_param_str=&__dt=<rand>&__t=<ms>
const store = require("./store");

const BASE = "https://drive-pc.quark.cn/1/clouddrive";
const FOLDER_NAME = process.env.QUARK_FOLDER || "netdisk_hub";

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
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Origin: "https://pan.quark.cn",
    Referer: "https://pan.quark.cn/",
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 统一的请求 + 错误包装:夸克返回 {code:0, message, data:{...}}
async function quarkFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const j = await res.json().catch(() => ({}));
  if (!j || typeof j.code === "undefined") {
    throw new Error("夸克接口返回异常: " + JSON.stringify(j).slice(0, 300));
  }
  return j;
}

// ── 解析别人分享链接 → {pwdId, passcode} ───────────────────────
function parseLink(link) {
  const s = (link || "").trim();
  const m = s.match(/pan\.quark\.cn\/s\/([A-Za-z0-9_-]+)/);
  const pwdId = m ? m[1] : s;
  let passcode = "";
  const pm = s.match(/[?&]pwd=([^&]+)/);
  if (pm) passcode = decodeURIComponent(pm[1]);
  return { pwdId, passcode };
}

// ── 取有效 Cookie(无则 null) ─────────────────────────────────
function getValidCookie() {
  const acc = store.getAccount("quark");
  if (!acc || !acc.cookie) return null;
  return acc.cookie;
}

// ── 1. 拿 stoken(转存凭证,同时可当存活检查) ───────────────
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

// ── 2. 取分享文件列表(自动翻页) ───────────────────────────
async function getDetail(cookie, pwdId, stoken) {
  const out = [];
  let page = 1;
  while (true) {
    const params = qp({
      pwd_id: pwdId,
      stoken,
      pdir_fid: "0",
      _page: String(page),
      _size: "50",
      _fetch_total: "1",
    });
    const j = await quarkFetch(`${BASE}/share/sharepage/detail?${params}`, {
      headers: headers(cookie),
    });
    if (j.code !== 0) throw new Error("获取分享列表失败: " + (j.message || JSON.stringify(j)));
    const list = (j.data && j.data.list) || [];
    for (const it of list) {
      out.push({
        fid: it.fid,
        share_fid_token: it.share_fid_token || it.fid_token,
        file_name: it.file_name,
        size: it.size,
        dir: !!it.dir,
      });
    }
    if (list.length < 50) break;
    page++;
  }
  return out;
}

// ── 3. 转存到我的网盘(返回 task_id) ───────────────────────
async function saveShare(cookie, { pwdId, stoken, fidList, fidTokenList, toPdirFid }) {
  const params = qp();
  const body = {
    fid_list: fidList,
    share_fid_token_list: fidTokenList,
    to_pdir_fid: toPdirFid,
    pwd_id: pwdId,
    stoken,
    pdir_fid: "0",
    scene: "link",
  };
  const j = await quarkFetch(`${BASE}/share/sharepage/save?${params}`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
  if (j.code !== 0) throw new Error("转存失败: " + (j.message || JSON.stringify(j)));
  return j.data; // {task_id}
}

// ── 4. 轮询任务状态(status:1=进行中 2=成功 3=失败) ───────
async function pollTask(cookie, taskId, max = 40) {
  for (let i = 0; i < max; i++) {
    const params = qp({ task_id: taskId, retry_index: String(i) });
    const j = await quarkFetch(`${BASE}/task?${params}`, { headers: headers(cookie) });
    if (j.code !== 0) throw new Error("查询转存任务失败: " + (j.message || JSON.stringify(j)));
    const d = j.data || {};
    if (d.status === 2) return d;
    if (d.status === 3) throw new Error("转存任务失败: " + (d.message || "未知错误"));
    const gap = d.metadata && d.metadata.tq_gap ? d.metadata.tq_gap / 1000 : 1;
    await sleep(gap * 1000);
  }
  throw new Error("转存任务超时(轮询 " + max + " 次)");
}

// ── 确保目标文件夹存在,返回其 fid ──────────────────────────
async function ensureFolder(cookie) {
  const params = qp();
  const j = await quarkFetch(`${BASE}/file?${params}`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify({
      pdir_fid: "0",
      file_name: FOLDER_NAME,
      dir_path: "",
      dir_init_lock: false,
    }),
  });
  if (j.code === 0 && j.data && j.data.fid) return j.data.fid;
  if (j.code === 23008) {
    const fid = await findFolderByName(cookie, FOLDER_NAME);
    if (fid) return fid;
  }
  throw new Error("创建/查找夸克文件夹失败: " + (j.message || JSON.stringify(j)));
}

async function findFolderByName(cookie, name) {
  const params = qp({
    pdir_fid: "0",
    _page: "1",
    _size: "100",
    _fetch_total: "1",
    _sort: "file_type:asc,updated_at:desc",
  });
  const j = await quarkFetch(`${BASE}/file/sort?${params}`, { headers: headers(cookie) });
  if (j.code !== 0) return null;
  const list = (j.data && j.data.list) || [];
  const f = list.find((x) => x.file_name === name && x.dir);
  return f ? f.fid : null;
}

// ── 列出某文件夹内容(用于取出刚转存文件的 fid) ───────────
async function listFolder(cookie, fid) {
  const params = qp({
    pdir_fid: fid,
    _page: "1",
    _size: "200",
    _fetch_total: "1",
    _sort: "file_type:asc,updated_at:desc",
  });
  const j = await quarkFetch(`${BASE}/file/sort?${params}`, { headers: headers(cookie) });
  if (j.code !== 0) throw new Error("列出文件夹失败: " + (j.message || JSON.stringify(j)));
  return ((j.data && j.data.list) || []).map((x) => ({
    fid: x.fid,
    file_name: x.file_name,
    dir: !!x.dir,
    size: x.size || 0,
  }));
}

// 聚合搜索:列出指定文件夹第一层,按关键词过滤(不递归)
async function searchFiles(cookie, fid, keyword) {
  const kw = String(keyword || "")
    .trim()
    .toLowerCase();
  if (!kw) return [];
  const list = await listFolder(cookie, fid || "0");
  return list
    .filter((x) => x.file_name.toLowerCase().includes(kw))
    .map((x) => ({ id: x.fid, name: x.file_name, isdir: x.dir, size: x.size }));
}

// 删除到回收站(软删,可恢复);action_type 2 = 删除
async function trashFiles(cookie, fids) {
  if (!fids || !fids.length) throw new Error("删除失败:缺少文件 fid");
  const j = await quarkFetch(`${BASE}/file/delete?${qp()}`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify({ action_type: 2, filelist: fids.map(String), exclude_fids: [] }),
  });
  if (j.code !== 0) throw new Error("夸克删除失败: " + (j.message || JSON.stringify(j)));
  return j;
}

// 列出某目录下的「子文件夹」(供网页端目录选择器浏览树使用)
// parentFid 根目录传 '0';返回 [{id: fid, name: 文件夹名}]
async function listSubfolders(cookie, parentFid) {
  const params = qp({
    pdir_fid: parentFid || "0",
    _page: "1",
    _size: "200",
    _fetch_total: "1",
    _sort: "file_type:asc,updated_at:desc",
  });
  const j = await quarkFetch(`${BASE}/file/sort?${params}`, { headers: headers(cookie) });
  if (j.code !== 0) throw new Error("列出文件夹失败: " + (j.message || JSON.stringify(j)));
  const list = (j.data && j.data.list) || [];
  return list.filter((x) => x.dir === true).map((x) => ({ id: x.fid, name: x.file_name }));
}

// ── 5. 生成我的分享链接 ───────────────────────────────────
// period: 0=永久, 其他按夸克档位映射;password 为空则不设提取码
function mapExpiredType(period) {
  if (!period || period === 0) return 1; // 永久
  if (period === 1) return 2;
  if (period === 7) return 3;
  if (period === 30) return 4;
  return 1;
}

async function createShare(cookie, fidList, period, password) {
  const expiredType = mapExpiredType(period);
  const body = {
    fid_list: fidList,
    title: "netdisk_hub 分享",
    expired_type: expiredType,
    url_type: 1,
    passcode_setting: password ? 1 : 0,
  };
  if (password) body.passcode = password;
  const params = qp();
  const j = await quarkFetch(`${BASE}/share?${params}`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
  if (j.code !== 0) throw new Error("生成分享失败: " + (j.message || JSON.stringify(j)));
  const d = j.data || {};
  // 同步返回路径:直接取链接与提取码(最可靠)
  let link = d.share_url || (d.share_id ? `https://pan.quark.cn/s/${d.share_id}` : "");
  let pass = d.passcode || "";
  // 异步创建(仅返回 task_id):轮询完成后从「我的分享」精确匹配本次分享,
  // 避免并发批量转存时拿到别人的分享(原 list[0] 拿错问题);
  // 匹配不到再回退取最新一条。提取码优先用创建响应里的,缺失才用列表里的。
  if (!link && d.task_id) {
    try {
      await pollTask(cookie, d.task_id);
    } catch (e) {
      /* 忽略轮询异常 */
    }
    const fidSet = new Set(fidList.map(String));
    for (let i = 0; i < 12; i++) {
      const list = await getMyShareList(cookie);
      if (list.length) {
        const matched = list.find(
          (s) => Array.isArray(s.fid_list) && s.fid_list.map(String).some((f) => fidSet.has(f)),
        );
        const top = matched || list[0];
        const l = top.share_url || (top.share_id ? `https://pan.quark.cn/s/${top.share_id}` : "");
        if (l) {
          link = l;
          pass = top.passcode || pass;
          break;
        }
      }
      await sleep(1500);
    }
  }
  if (!link) {
    throw new Error("生成分享成功但未返回链接: " + JSON.stringify({ data: d }).slice(0, 240));
  }
  const quarkShareRe = /^(https?:\/\/)?pan\.quark\.cn\/s\/[A-Za-z0-9_-]{5,}$/;
  const linkNoQs = link.split("?")[0].split("#")[0];
  if (!quarkShareRe.test(linkNoQs)) {
    throw new Error(
      "生成分享成功但返回链接不完整: " + JSON.stringify({ link, data: d }).slice(0, 240),
    );
  }
  return { link, password: pass };
}

async function getMyShareList(cookie) {
  const params = qp({ _page: "1", _size: "50", _fetch_total: "1" });
  const j = await quarkFetch(`${BASE}/share/mypage/detail?${params}`, { headers: headers(cookie) });
  if (j.code !== 0) return [];
  return (j.data && j.data.list) || [];
}

// ── 编排:完整转存(+可选生成分享) ─────────────────────────
// toPdirFid / folderName: 网页端用户选定的转存目录(优先于默认 QUARK_FOLDER)。
//   - 传 toPdirFid(真实 fid):直接使用,不再查找/创建
//   - 仅传 folderName:按名查找已有目录,找不到则退回默认目录
//   - 都不传:走 ensureFolder(默认 QUARK_FOLDER,find-or-create)
async function transfer({
  cookie,
  pwdId,
  passcode,
  makeShare,
  sharePeriod,
  sharePassword,
  toPdirFid,
  folderName,
}) {
  const stoken = await getStoken(cookie, pwdId, passcode);
  const list = await getDetail(cookie, pwdId, stoken);
  if (!list.length) throw new Error("该分享为空或无法读取文件列表");

  let destFid;
  if (toPdirFid) {
    destFid = toPdirFid; // 用户已选目录,直接使用
  } else if (folderName) {
    destFid = (await findFolderByName(cookie, folderName)) || (await ensureFolder(cookie));
  } else {
    destFid = await ensureFolder(cookie);
  }
  const saveRes = await saveShare(cookie, {
    pwdId,
    stoken,
    fidList: list.map((f) => f.fid),
    fidTokenList: list.map((f) => f.share_fid_token),
    toPdirFid: destFid,
  });
  await pollTask(cookie, saveRes.task_id);

  const fileList = list.map((f) => ({
    path: `/${f.file_name}`,
    server_filename: f.file_name,
    size: f.size,
  }));

  let share = null;
  if (makeShare) {
    const saved = await listFolder(cookie, destFid);
    const names = new Set(list.map((f) => f.file_name));
    const targetFids = saved.filter((s) => names.has(s.file_name)).map((s) => s.fid);
    if (targetFids.length) {
      share = await createShare(cookie, targetFids, sharePeriod || 0, sharePassword || "");
    }
  }

  const displayName = folderName || FOLDER_NAME;
  return { file_list: fileList, share, destPath: "/" + displayName, task_id: saveRes.task_id };
}

// 轻量存活检查:列根目录,code===0 即 cookie 有效
async function checkSession() {
  const cookie = getValidCookie();
  if (!cookie) return false;
  try {
    const j = await quarkFetch(`${BASE}/file/sort?${qp()}`, {
      headers: headers(cookie),
      signal: AbortSignal.timeout(6000),
    });
    return j.code === 0;
  } catch (e) {
    return false;
  }
}

module.exports = {
  FOLDER_NAME,
  parseLink,
  mapExpiredType,
  getValidCookie,
  checkSession,
  getStoken,
  getDetail,
  saveShare,
  pollTask,
  ensureFolder,
  listFolder,
  searchFiles,
  trashFiles,
  listSubfolders,
  createShare,
  transfer,
};
