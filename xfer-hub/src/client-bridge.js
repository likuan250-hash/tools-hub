// 官方客户端接力：探测百度/夸克客户端的安装位置，并按各自的命令行约定唤起下载。
// 设计要点：
//   · 只做"探测 + 组命令 + 唤起"，不碰客户端私有协议（P2P/局域网加速由客户端自己吃）
//   · launch() 支持 dryRun（单测用它校验命令串，绝不会真的把客户端拉起来）
//   · 客户端路径可被环境变量覆盖：XFER_BAIDU_CLIENT / XFER_QUARK_CLIENT
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/** 百度客户端候选路径（本机实测装在 D 盘，同时保留常见位置） */
const BAIDU_CANDIDATES = [
  process.env.XFER_BAIDU_CLIENT,
  "C:\\Program Files\\Baidu\\BaiduNetdisk\\BaiduNetdisk.exe",
  "C:\\Program Files (x86)\\Baidu\\BaiduNetdisk\\BaiduNetdisk.exe",
  "D:\\Program Files\\BaiduNetdisk\\BaiduNetdisk.exe",
  path.join(process.env.LOCALAPPDATA || "", "Baidu", "BaiduNetdisk", "BaiduNetdisk.exe"),
];

/** 夸克客户端候选路径 */
const QUARK_CANDIDATES = [
  process.env.XFER_QUARK_CLIENT,
  path.join(process.env.LOCALAPPDATA || "", "Programs", "QuarkCloudDrive", "quark_cloud_drive.exe"),
  "C:\\Program Files\\QuarkCloudDrive\\quark_cloud_drive.exe",
  "D:\\QuarkCloudDrive\\quark_cloud_drive.exe",
];

/** 从候选里挑第一个真实存在的可执行文件 */
function detectClient(provider, candidates) {
  const list = (candidates || (provider === "baidu" ? BAIDU_CANDIDATES : QUARK_CANDIDATES)).filter(Boolean);
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) { /* 忽略不可访问路径 */ }
  }
  return "";
}

/** 两端客户端都探一遍，返回 { baidu, quark } */
function detectAllClients() {
  return { baidu: detectClient("baidu"), quark: detectClient("quark") };
}

/**
 * 组唤起命令（纯函数，便于单测）。
 * 百度：注册表里有 `BaiduYunGuanjia.torrent → BaiduNetdisk.exe "%1"`，说明接受单个参数。
 * 夸克：注册表里有 `--single-argument %1` 与 `--brand-clouddrive "%1"` 两种写法。
 * @returns {{exe:string, args:string[]}|null}
 */
function buildLaunch(provider, clientPath, target) {
  if (!clientPath) return null;
  const t = String(target == null ? "" : target);
  if (!t) return null;
  if (provider === "baidu") return { exe: clientPath, args: [t] };
  if (provider === "quark") return { exe: clientPath, args: ["--single-argument", t] };
  return null;
}

/**
 * 唤起客户端（默认 dryRun=true，只有显式传 dryRun:false 才真的拉起）。
 * @param {"baidu"|"quark"} provider
 * @param {string} target 分享链接或网盘路径
 * @param {{dryRun?:boolean, onLog?:Function}} [opts]
 */
function launch(provider, target, opts = {}) {
  const clientPath = detectClient(provider);
  const cmd = buildLaunch(provider, clientPath, target);
  if (!cmd) {
    return { ok: false, reason: clientPath ? "缺少目标参数" : `未找到${provider === "baidu" ? "百度" : "夸克"}客户端`, clientPath };
  }
  const dryRun = opts.dryRun !== false; // 默认不真启动，防误触
  if (opts.onLog) opts.onLog(`[client] ${provider} 接力: ${cmd.exe} ${cmd.args.join(" ")}`);
  if (dryRun) return { ok: true, dryRun: true, ...cmd };
  try {
    const child = spawn(cmd.exe, cmd.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, dryRun: false, ...cmd, pid: child.pid };
  } catch (e) {
    return { ok: false, reason: e.message, ...cmd };
  }
}

module.exports = { detectClient, detectAllClients, buildLaunch, launch, BAIDU_CANDIDATES, QUARK_CANDIDATES };
