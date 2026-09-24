// 轻量偏好存储：记住「转存到哪个目录」。
//
// 语义与 netdisk-hub 的「选择目录」保持一致：全局记住，下次打开还在那儿。
// 为什么不用 netdisk-hub 的 store.json：那是它的凭证库，本工具只读不写
// （见 creds.js 的安全边界）。这里另存一份自己的 prefs.json，互不干扰。
//
// 存放位置：XFER_DATA_DIR/prefs.json（工具箱注入 → userData/xfer-hub）；
// 独立运行时回退到本工具目录下 data/。原子写（先写 .tmp 再 rename）。
const fs = require("fs");
const path = require("path");

const log = require("./logger");

function dataDir() {
  const d =
    process.env.XFER_DATA_DIR ||
    path.join(process.env.APPDATA || "", "tools-hub", "xfer-hub");
  return d;
}

function prefsPath() {
  return path.join(dataDir(), "prefs.json");
}

function read() {
  try {
    const s = fs.readFileSync(prefsPath(), "utf8");
    const o = JSON.parse(s);
    return o && typeof o === "object" ? o : {};
  } catch (_) {
    return {};
  }
}

function write(obj) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = prefsPath();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, p); // 原子替换，避免半截 JSON
  return obj;
}

// 默认目录（与 xfer.js / 前端 DEFAULTS 三处必须一致）
const DEFAULTS = { quark: "/夸克中转文件夹", baidu: "/百度中转文件夹" };

// 读某家网盘的目标目录。未设置过 → 返回默认值（userSet=false）。
function getTargetDir(provider) {
  const p = provider === "baidu" ? "baidu" : "quark";
  const saved = (read().targetDir || {})[p];
  if (saved && saved.path) {
    return { path: saved.path, name: saved.name || "", id: saved.id || "", userSet: true };
  }
  return { path: DEFAULTS[p], name: "", id: "", userSet: false };
}

// 写某家网盘的目标目录。
function setTargetDir(provider, { path: p, name = "", id = "" }) {
  const key = provider === "baidu" ? "baidu" : "quark";
  const clean = String(p || "").trim();
  if (!clean) throw new Error("目录不能为空");
  const all = read();
  all.targetDir = all.targetDir || {};
  all.targetDir[key] = { path: clean, name: String(name || ""), id: String(id || ""), at: Date.now() };
  write(all);
  log.info(`目标目录已保存 [${key}]:`, clean);
  return getTargetDir(key);
}

// 全部两家的当前设置（给前端一次拿齐）
function allTargetDirs() {
  return { quark: getTargetDir("quark"), baidu: getTargetDir("baidu") };
}

// ── 中转目录（本地落盘路径，全局唯一，不区分网盘）──
// 下载阶段文件先落这个目录，再上传到目标网盘。默认放 E 盘机械盘
// （用户已确认 E 盘扛反复读写），用户可在界面改成任意本地路径并持久化。
const DEFAULT_TMP_DIR = "E:\\网盘中转";

function getTmpDir() {
  const saved = (read().tmpDir) || {};
  if (saved && saved.path) {
    return { path: saved.path, userSet: !!saved.userSet };
  }
  return { path: DEFAULT_TMP_DIR, userSet: false };
}

function setTmpDir(p) {
  const clean = String(p || "").trim();
  if (!clean) throw new Error("目录不能为空");
  const all = read();
  all.tmpDir = { path: clean, userSet: true, at: Date.now() };
  write(all);
  log.info("中转目录已保存:", clean);
  return getTmpDir();
}

// 下载方式："builtin" = 内建多连接并发下载；"client" = 官方客户端接力（客户端吃 P2P/专属节点）
function getDownloadMode() {
  const v = String(read().downloadMode || "").trim();
  return v === "client" ? "client" : "builtin";
}

function setDownloadMode(mode) {
  const v = String(mode || "").trim() === "client" ? "client" : "builtin";
  const cur = read();
  cur.downloadMode = v;
  write(cur);
  return v;
}

module.exports = { DEFAULTS, getTargetDir, setTargetDir, allTargetDirs, getTmpDir, setTmpDir, DEFAULT_TMP_DIR, prefsPath, getDownloadMode, setDownloadMode };
