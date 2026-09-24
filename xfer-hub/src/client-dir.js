// 客户端下载目录探测：不用用户改任何设置，直接读客户端自己记的下载目录。
// 探测顺序（读不到就降级）：
//   1) 客户端配置/注册表里记的下载路径
//   2) 常见下载目录（%USERPROFILE%\Downloads、桌面等）
//   3) 返回空串（上层再做兜底提示）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/** 配置里可能出现"下载目录"的键名（大小写/中英混排都覆盖） */
const PATH_KEYS = [
  "downloadpath", "downloaddir", "downloadfolder", "download_path", "savepath", "savedir",
  "localdownloadpath", "defaultdownloadpath", "下载目录", "下载路径",
];

/** 从一段文本里抽"看起来像 Windows 绝对路径"的值（配置文件可能是 JSON / INI / 转义过的） */
function extractPaths(text) {
  if (!text) return [];
  const out = [];
  // 兼容三种写法：JSON("downloadPath": "X")、INI(savepath="X")、无引号键(savepath=X)
  const re = /["']?([A-Za-z_]*?(?:download|save)[A-Za-z_]*?)["']?\s*[:=]\s*["']?([^"'\r\n]+)/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[2].trim());
  // JSON 里被转义成 \\ 的路径还原
  return out.map((p) => p.replace(/\\\\/g, "\\").replace(/\//g, "\\"));
}

/** 判断一个字符串是否是"存在的目录"（探测结果必须真实存在才有意义） */
function isRealDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * 读客户端配置目录下的文本文件，找下载路径。
 * @param {string[]} roots 配置目录候选
 * @param {{maxBytes?:number}} [opts]
 */
function scanConfigDirs(roots, opts = {}) {
  const maxBytes = opts.maxBytes || 512 * 1024;
  for (const root of roots.filter(Boolean)) {
    let files = [];
    try {
      files = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(root, d.name));
    } catch (e) {
      continue;
    }
    for (const f of files) {
      try {
        if (fs.statSync(f).size > maxBytes) continue;
        const text = fs.readFileSync(f, "utf8");
        for (const p of extractPaths(text)) {
          if (isRealDir(p)) return p;
        }
      } catch (e) { /* 二进制/无权限跳过 */ }
    }
  }
  return "";
}

/** 读注册表某个键的所有值，找下载路径（Windows only，失败静默） */
function scanRegistry(keyPath) {
  try {
    const out = execFileSync("reg", ["query", keyPath, "/s"], { encoding: "utf8", timeout: 4000, windowsHide: true });
    for (const line of String(out).split(/\r?\n/)) {
      const m = /\s(REG_SZ|REG_EXPAND_SZ)\s+(.+)$/.exec(line);
      if (!m) continue;
      const lower = line.toLowerCase();
      if (!PATH_KEYS.some((k) => lower.includes(k))) continue;
      const val = m[2].trim().replace(/\\\\/g, "\\");
      if (isRealDir(val)) return val;
    }
  } catch (e) { /* 键不存在或无权限 */ }
  return "";
}

function commonDownloadDirs(env = process.env) {
  const home = env.USERPROFILE || os.homedir();
  return [
    path.join(home, "Downloads"),
    path.join(home, "下载"),
    path.join(home, "Desktop"),
    path.join(home, "桌面"),
  ].filter(Boolean);
}

/**
 * 探测某家网盘客户端的下载目录。
 * @param {"baidu"|"quark"} provider
 * @param {{env?:object, scan?:Function, reg?:Function}} [deps] 单测注入
 * @returns {string} 真实存在的目录；探测不到返回空串
 */
function detectDownloadDir(provider, deps = {}) {
  const env = deps.env || process.env;
  const scan = deps.scan || scanConfigDirs;
  const reg = deps.reg || scanRegistry;
  const appdata = env.APPDATA || "";
  const local = env.LOCALAPPDATA || "";
  const home = env.USERPROFILE || "";

  if (provider === "baidu") {
    const roots = [
      path.join(appdata, "Baidu", "BaiduNetdisk"),
      path.join(local, "Baidu", "BaiduNetdisk"),
      path.join(home, "Baidu", "BaiduNetdisk"),
    ];
    const fromCfg = scan(roots);
    if (fromCfg) return fromCfg;
    const fromReg = reg("HKCU\\Software\\Baidu\\BaiduNetdisk");
    if (fromReg) return fromReg;
  } else if (provider === "quark") {
    const roots = [path.join(local, "QuarkCloudDrive"), path.join(appdata, "QuarkCloudDrive")];
    // 夸克是版本目录结构（QuarkCloudDrive/<version>/…），把版本子目录也展开一层
    const expanded = [];
    for (const r of roots) {
      expanded.push(r);
      try {
        for (const d of fs.readdirSync(r, { withFileTypes: true })) {
          if (d.isDirectory()) expanded.push(path.join(r, d.name));
        }
      } catch (e) { /* 不存在则跳过 */ }
    }
    const fromCfg = scan(expanded);
    if (fromCfg) return fromCfg;
    const fromReg = reg("HKCU\\Software\\QuarkCloudDrive");
    if (fromReg) return fromReg;
  }
  return "";
}

/** 兜底：常见下载目录里第一个存在的 */
function fallbackDownloadDir(env = process.env) {
  return commonDownloadDirs(env).find(isRealDir) || "";
}

/**
 * 把「任务清单的相对路径」映射到客户端下载目录下的实际路径。
 * 客户端下的是我们转存出来的那个顶层文件夹（rootName），所以：
 *   rootName 存在 → <clientDir>/<rootName>/<rel 去掉顶层>/…
 *   否则（散文件）→ <clientDir>/<rel>
 * @param {string} clientDir
 * @param {string} rootName
 * @param {string} rel 形如 "顶层/子目录/文件.rar"
 */
function localPathFor(clientDir, rootName, rel) {
  const segs = String(rel || "").split("/").filter(Boolean);
  const base = rootName && segs[0] === rootName ? segs.slice(1) : segs;
  return path.join(clientDir, ...base);
}

module.exports = {
  detectDownloadDir, fallbackDownloadDir, localPathFor, extractPaths, commonDownloadDirs, scanConfigDirs, PATH_KEYS,
};
