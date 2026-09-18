// 凭证复用层：只读 netdisk-hub 已保存的登录态，绝不写入。
//
// 为什么复用而不自己登录：
//   netdisk-hub 已经把百度/夸克的登录态加密存在 userData/netdisk-hub/data/store.json，
//   主密钥在 userData/.masterkey（AES-256-GCM）。再走一遍 Playwright 扫码纯属浪费，
//   且会让用户在两个地方重复授权。
//
// 安全边界：
//   1) 本模块只调 store.js 的 getAccount()，不调 saveAccount / deleteAccount。
//   2) 不 require netdisk-hub 的 server.js，不启它的进程，不碰它的端口。
//   3) 若 netdisk-hub 未登录 → 明确报错引导用户去那边登录，而不是自己弹浏览器。
const path = require("path");
const fs = require("fs");
const { createRequire } = require("module");

const log = require("./logger");

// netdisk-hub 的数据目录：与它自身 store.js 的解析逻辑保持一致。
// 优先用工具箱注入的 NETDISK_DATA_DIR；独立运行时回退到它的安装目录 data/。
function resolveNetdiskDataDir() {
  if (process.env.NETDISK_DATA_DIR) return path.resolve(process.env.NETDISK_DATA_DIR);

  // 工具箱运行时会注入；独立跑 xfer-hub 时按常见位置探测
  const candidates = [
    path.join(process.env.APPDATA || "", "tools-hub", "netdisk-hub", "data"),
    path.join(process.env.RESOURCES_PATH || "", "netdisk-hub", "data"),
    path.join(__dirname, "..", "..", "netdisk-hub", "data"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "store.json"))) return c;
  }
  return candidates[0];
}

// 定位 netdisk-hub 的安装目录（要 require 它的 store.js）
function resolveNetdiskDir() {
  const candidates = [
    process.env.NETDISK_DIR,
    process.env.RESOURCES_PATH ? path.join(process.env.RESOURCES_PATH, "netdisk-hub") : null,
    path.join(__dirname, "..", "..", "netdisk-hub"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "src", "store.js"))) return c;
  }
  return null;
}

let _store = null;
function loadStore() {
  if (_store) return _store;
  const dir = resolveNetdiskDir();
  if (!dir) throw new Error("找不到 netdisk-hub 安装目录（缺 src/store.js）");

  // 关键：先设 NETDISK_DATA_DIR，再 require。
  // store.js 在模块加载时就把 DATA_DIR 解析成常量了，之后再改环境变量无效。
  const dataDir = resolveNetdiskDataDir();
  process.env.NETDISK_DATA_DIR = dataDir;

  const req = createRequire(path.join(dir, "package.json"));
  _store = req(path.join(dir, "src", "store.js"));
  log.info("凭证层已挂载 netdisk-hub store，数据目录:", dataDir);
  return _store;
}

// 读某家网盘的账号信息（只读）
function getAccount(provider) {
  const s = loadStore();
  try {
    return s.getAccount(provider) || null;
  } catch (e) {
    log.warn(`读取 ${provider} 账号失败:`, e.message);
    return null;
  }
}

// 百度：要 accessToken（开放平台 xpan），过期则报错提示去 netdisk-hub 重授权
function baiduToken() {
  const a = getAccount("baidu");
  if (!a || !a.connected) {
    throw new Error("百度未连接。请先在「网盘转存中转」里授权百度网盘，再回到本页。");
  }
  if (!a.accessToken) {
    throw new Error(
      "百度缺少 accessToken（开放平台凭证）。请在「网盘转存中转」重新授权百度网盘以获取 netdisk 权限。",
    );
  }
  const expired = a.expiresAt && Date.now() > a.expiresAt - 24 * 3600 * 1000;
  if (expired) {
    throw new Error(
      `百度 accessToken 即将/已过期（${new Date(a.expiresAt).toLocaleString("zh-CN")}）。` +
        "请在「网盘转存中转」重新授权百度网盘。",
    );
  }
  return { token: a.accessToken, refreshToken: a.refreshToken, expiresAt: a.expiresAt, account: a };
}

// 夸克：官方 Skill 自己管凭证（存在它的 credentials 里），
// 这里只做「是否已安装 + 是否已登录」的存在性检查，不读它的 token。
function quarkSkillDir() {
  const candidates = [
    process.env.QUARK_SKILL_DIR,
    process.env.RESOURCES_PATH ? path.join(process.env.RESOURCES_PATH, "quarkclouddrive") : null,
    path.join(process.env.USERPROFILE || "", ".workbuddy", "skills", "quarkclouddrive"),
    path.join(__dirname, "..", "..", "quarkclouddrive"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "scripts", "quark-drive.cjs"))) return c;
  }
  return null;
}

// 汇总当前可用状态（给前端展示）
function status() {
  const out = {
    baidu: { ok: false, reason: "", name: "", vip: 0 },
    quark: { ok: false, reason: "" },
    xunlei: { ok: false, reason: "本版本不做迅雷（无官方开放平台）" },
  };

  try {
    const t = baiduToken();
    out.baidu.ok = true;
    out.baidu.expiresAt = t.expiresAt;
    if (t.account && t.account.loginAt) out.baidu.loginAt = t.account.loginAt;
  } catch (e) {
    out.baidu.reason = e.message;
  }

  const qd = quarkSkillDir();
  if (!qd) {
    out.quark.reason = "未找到夸克官方 Skill（quark-drive.cjs）";
  } else {
    out.quark.ok = true;
    out.quark.dir = qd;
  }

  return out;
}

module.exports = { getAccount, baiduToken, quarkSkillDir, status, resolveNetdiskDataDir };
