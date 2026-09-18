// 分享链接 → 自己网盘（站内转存）
//
// 为什么这一层要复用 netdisk-hub 的逆向代码：
//   百度开放平台的 xpan 不提供「转存别人分享」的接口（只有 file/list/upload/download 这些
//   操作自己网盘的）。夸克开放平台同理。所以「把别人的分享收进自己网盘」这一步，
//   在两家都只能走网页端接口，而 netdisk-hub 已经把这部分跑通了。
//
// 严格边界（用户铁律：不修改 netdisk-hub 任何文件）：
//   - 全程只 require 它的模块、只调它的只读/业务函数，不写它的任何文件、不改它的 store。
//   - 转存产生的数据变化发生在「用户自己的网盘」上，与 netdisk-hub 的本地文件无关。
//
// 转存后必须做的一步：netdisk-hub 的 getShareList 不解析文件大小（size 恒为 0），
// 所以收进网盘后要重新 list 目标目录，拿到真实 size/fs_id，才能交给下载层。
const path = require("path");
const fs = require("fs");
const { createRequire } = require("module");

const log = require("./logger");
const creds = require("./creds");
const bd = require("./baidu-official");

function loadNetdiskModules() {
  const dirs = [
    process.env.NETDISK_DIR,
    process.env.RESOURCES_PATH ? path.join(process.env.RESOURCES_PATH, "netdisk-hub") : null,
    path.join(__dirname, "..", "..", "netdisk-hub"),
  ].filter(Boolean);

  let dir = null;
  for (const d of dirs) {
    if (fs.existsSync(path.join(d, "src", "baidu.js"))) {
      dir = d;
      break;
    }
  }
  if (!dir) throw new Error("找不到 netdisk-hub（缺 src/baidu.js）");

  // 与 creds 同理：先固定数据目录，再 require
  process.env.NETDISK_DATA_DIR = creds.resolveNetdiskDataDir();
  const req = createRequire(path.join(dir, "package.json"));
  return {
    baidu: req(path.join(dir, "src", "baidu.js")),
    quark: req(path.join(dir, "src", "quark.js")),
  };
}

let _mods = null;
function mods() {
  if (!_mods) _mods = loadNetdiskModules();
  return _mods;
}

// 解析链接，判断是哪家
function detectProvider(link) {
  const s = (link || "").trim();
  if (/pan\.baidu\.com|baidu\.com\/s\//i.test(s)) return "baidu";
  if (/pan\.quark\.cn|quark\.cn\/s\//i.test(s)) return "quark";
  if (/pan\.xunlei\.com|xunlei\.com/i.test(s)) return "xunlei";
  return null;
}

// 从任意分享页文本里抽提取码（用户可能连文案一起粘进来）
function extractPwd(link) {
  const s = link || "";
  // 支持：pwd=xxxx / 提取码: xxxx / 提取码：xxxx / 密码 xxxx
  const m =
    s.match(/[?&]pwd=([A-Za-z0-9]{4})/i) ||
    s.match(/提取码[:：\s]*([A-Za-z0-9]{4})/i) ||
    s.match(/密码[:：\s]*([A-Za-z0-9]{4})/i);
  return m ? m[1] : "";
}

// 剥离链接里的干扰文字，取出纯 URL（用户常把「xxx 提取码:abcd」整段粘进来）
function extractUrl(link) {
  const s = (link || "").trim();
  // 百度可能给完整 https 链接，也可能只给 /s/1xxxx 片段
  const m = s.match(/https?:\/\/[^\s　,，、"'）)]+/i);
  if (m) return m[0];
  const m2 = s.match(/\/s\/[A-Za-z0-9_-]+/);
  if (m2) return m2[0];
  return s.split(/\s+/)[0];
}

// ── 百度：把分享收进自己网盘指定目录，返回落在网盘里的条目（含真实 size） ──
async function baiduSaveShare(link, destPath) {
  const { baidu } = mods();
  const url = extractUrl(link);
  const pwd = extractPwd(link) || undefined;
  const surl = baidu.parseSurl(url);

  log.info("百度：解析分享", surl, pwd ? "(带提取码)" : "(无提取码)");
  const info = await baidu.getShareList(surl, pwd);
  log.info(`百度：分享含 ${info.list.length} 个条目`);

  const fsIds = info.list.map((x) => Number(x.fs_id)).filter(Boolean);
  if (!fsIds.length) throw new Error("分享里没有可转存的文件");

  await baidu.ensureDir(destPath);

  // 兜住「文件已存在」这一类 errno：
  //   netdisk-hub/src/baidu.js 的 transfer() 只放行了 0 / 4 / 12，
  //   实测还有 errno=2「文件已存在」——当你把文件分享给自己、目标目录里本来就有同名文件时
  //   就会命中。这种情况文件已经在网盘里了，语义上等同成功，不该让整条链路失败。
  //   （不改 netdisk-hub 源码，这里包一层重试。）
  let res;
  try {
    res = await baidu.transfer(info.shareid, info.uk, fsIds, destPath);
  } catch (e) {
    const m = String(e.message || "").match(/errno=(\d+)/);
    const code = m ? Number(m[1]) : NaN;
    if ([2, 4, 12].includes(code)) {
      log.warn(`百度转存返回 errno=${code}（文件已存在），视作成功，直接走后续流程`);
      res = { file_list: [], task_id: null, errno: code };
    } else {
      throw e;
    }
  }
  log.info(`百度：转存完成，返回 ${(res.file_list || []).length} 条`);

  // 关键：转存接口返回的 size 可能是 0，重新 list 目标目录拿真实元数据。
  // 匹配顺序：
  //   1) 转存接口返回的 file_list 文件名
  //   2) 分享页解析出的文件名（errno=2/4/12 时 file_list 为空，但文件确实在目录里）
  // 不能用「退回整个目录」——那会把目录里的历史文件也当成本次要转的对象。
  const items = await bd.listDir(destPath);
  const names = new Set(
    [
      ...(res.file_list || []).map((f) => f.server_filename),
      ...info.list.map((x) => x.server_filename),
    ].filter(Boolean),
  );

  const picked = items.filter((f) => names.has(f.server_filename));
  if (!picked.length) {
    throw new Error(
      `转存后在目标目录「${destPath}」里没找到对应文件。` +
        `分享含 ${names.size} 个文件名，目录含 ${items.length} 项。` +
        "可能原因：转存被百度重命名，或目标目录选错了。",
    );
  }
  return picked;
}

// ── 夸克：同样先收进自己网盘 ──
// 注意：netdisk-hub/src/quark.js 的每个函数首参都是 cookie（它内部自己取）。
// 转存链路：parseLink → getStoken → getDetail → ensureFolder → saveShare → pollTask
async function quarkSaveShare(link) {
  const { quark } = mods();
  const { pwdId, passcode } = quark.parseLink(extractUrl(link));

  log.info("夸克：解析分享", pwdId, passcode ? "(带提取码)" : "");
  const cookie = await quark.getValidCookie();
  if (!cookie) throw new Error("夸克未登录，请先在「网盘转存中转」授权夸克网盘");
  if (quark.checkSession) quark.checkSession(cookie);

  const stoken = await quark.getStoken(cookie, pwdId, passcode);
  const list = await quark.getDetail(cookie, pwdId, stoken);
  if (!list.length) throw new Error("分享里没有可转存的文件");

  const destFid = await quark.ensureFolder(cookie);

  // 夸克禁止转存「自己的分享」（实测报「用户禁止转存自己的分享」）。
  // 这不影响跨盘：分享是我自己发的 → 文件本来就在我的夸克里，
  // 直接在网盘里按文件名定位即可，不必也不该再转存一份。
  let saved = false;
  try {
    const data = await quark.saveShare(cookie, {
      pwdId,
      stoken,
      fidList: list.map((x) => x.fid),
      fidTokenList: list.map((x) => x.share_fid_token),
      toPdirFid: destFid,
    });
    const taskId = data && (data.task_id || data.taskId);
    if (taskId) await quark.pollTask(cookie, taskId);
    saved = true;
    log.info("夸克：转存完成");
  } catch (e) {
    const msg = String(e.message || "");
    if (/禁止转存自己的分享|自己的分享/.test(msg)) {
      log.warn("夸克拒绝转存自己的分享，改为直接从自己网盘定位原文件");
    } else {
      throw e;
    }
  }

  const want = new Set(list.map((x) => x.file_name).filter(Boolean));

  if (saved) {
    // 列出目标目录，按分享里的文件名对齐出本次落盘的条目
    const items = await quark.listFolder(cookie, destFid, { all: true });
    const picked = items.filter((f) => want.has(f.file_name));
    if (picked.length) return { items: picked, destFid, cookie, saved: true };
    log.warn("转存后目标目录里没找到，退回全盘搜索");
  }

  // 降级：在夸克网盘里按文件名搜索（自己的分享走这条路）
  const rootItems = await quark.listFolder(cookie, "0", { all: true });
  const picked = rootItems.filter((f) => want.has(f.file_name));
  if (!picked.length) {
    throw new Error(
      `夸克转存失败且在自己网盘里也没找到对应文件（分享含：${[...want].join("、")}）`,
    );
  }
  log.info(`夸克：在自己网盘直接定位到 ${picked.length} 个文件`);
  return { items: picked, destFid, cookie, saved: false };
}

module.exports = { detectProvider, extractPwd, extractUrl, baiduSaveShare, quarkSaveShare };
