// tools-hub 主进程（Electron）
// 职责：单实例锁、fork 两个 node 子进程(kdocs/netdisk)、原生文件对话框、状态推送、看门狗、自动更新。
// 启动后渲染进程显示入口页；点击卡片后在同一窗口内以 <webview> 标签打开工具。
const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const { fork } = require("child_process");
const fs = require("fs");

const RES = process.resourcesPath; // 开发时=项目根，打包后=resources 目录
const KDOCS_DIR = path.join(RES, "kdocs-tool");
const NETDISK_DIR = path.join(RES, "netdisk-hub");

// Node 运行时：打包后自带 resources/node/node.exe；开发时回退系统 PATH 的 node
const NODE_BIN = fs.existsSync(path.join(RES, "node", "node.exe"))
  ? path.join(RES, "node", "node.exe")
  : "node";

// bl CLI：打包后用自带的 resources/bin/bl.cmd（由 NODE_BIN 运行 bailian.mjs）；
// 否则回退 BL_BIN_PATH 环境变量或 PATH 中的 bl（开发 / 独立运行）
function resolveBlBin() {
  const bundled = path.join(RES, "bin", "bl.cmd");
  if (fs.existsSync(bundled)) return bundled;
  return process.env.BL_BIN_PATH || "bl";
}
const BL_BIN = resolveBlBin();

// webview 内嵌页面用的 preload（提供 pickFolder 等有限原生能力）
const WEBVIEW_PRELOAD = path.join(__dirname, "webview-preload.js");

// 子进程注册表
const CHILDREN = {
  kdocs: {
    key: "kdocs",
    name: "金山文档录入",
    script: path.join(KDOCS_DIR, "server.js"),
    cwd: KDOCS_DIR,
    url: "http://localhost:3599",
    env: Object.assign({}, process.env, {
      KDOCS_PORT: "3599",
      BL_BIN_PATH: BL_BIN, // 注入 bl 二进制绝对路径，kdocs 优先使用
    }),
    proc: null,
    running: false,
    attempts: 0,
  },
  netdisk: {
    key: "netdisk",
    name: "网盘转存中转",
    script: path.join(NETDISK_DIR, "server.js"),
    cwd: NETDISK_DIR,
    url: "http://localhost:3000",
    env: Object.assign({}, process.env, { PORT: "3000", PLAYWRIGHT_BROWSERS_PATH: "0" }),
    proc: null,
    running: false,
    attempts: 0,
  },
};

const MAX_RESTART = 5;
let mainWindow = null;
let quitting = false;
let allowClose = false;     // 更新安装等场景直接关闭，跳过确认
let confirmedClose = false; // 用户已在确认框点了“确认关闭”

// ── 打包后把 netdisk 可变数据(.env / data/)重定向到 userData，升级不丢 ──
// resources/ 在 NSIS 升级时会被覆盖，而 app.getPath('userData') 跨版本保留。
// 方案：.env 每次启动从 userData 恢复回 resources；data/ 用目录 junction 指向 userData。
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function backupDirIfNeeded(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const hasContent = fs.readdirSync(dir).some((n) => {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      return st.isDirectory() || st.size > 10;
    });
    if (!hasContent) return;
    const backupDir = `${dir}.backup-${Date.now()}`;
    copyDir(dir, backupDir);
    log("已创建数据备份:", backupDir);
  } catch (e) {
    log("备份失败:", e.message);
  }
}

function ensureJunction(target, linkPath) {
  // 已是正确 junction 则跳过
  try {
    if (fs.lstatSync(linkPath).isSymbolicLink() &&
        fs.realpathSync(linkPath) === fs.realpathSync(target)) return;
  } catch (e) { /* 不存在 */ }

  // target(用户数据目录/AppData) 必须优先保留，绝不能用安装包里的旧数据覆盖它
  let targetHasData = false;
  try {
    targetHasData = fs.existsSync(target) &&
      fs.readdirSync(target).some((n) => {
        const p = path.join(target, n);
        const st = fs.statSync(p);
        return st.isDirectory() || st.size > 10; // 忽略空文件/占位
      });
  } catch (e) {}

  // 若 linkPath 是真实目录（例如升级时安装包把 data 解压成了真实目录）
  let isRealDir = false;
  try {
    isRealDir = fs.statSync(linkPath).isDirectory() &&
                !fs.lstatSync(linkPath).isSymbolicLink();
  } catch (e) {}
  if (isRealDir) {
    if (!targetHasData) {
      // target 为空：把 linkPath 内容迁过去（首次安装场景）
      copyDir(linkPath, target);
    }
    // target 有数据：直接丢弃 linkPath（它是安装包带来的旧数据/错误数据），避免覆盖用户登录态
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(target, linkPath, "junction");
}

function relocateNetdiskData() {
  if (!app.isPackaged) return; // 仅打包后生效，开发模式不动源码目录
  const userDir = path.join(app.getPath("userData"), "netdisk-hub");
  fs.mkdirSync(path.join(userDir, "data"), { recursive: true });

  // .env：以 userData 为准；首次安装时若 userData 没有则从 resources 迁移
  const srcEnv = path.join(NETDISK_DIR, ".env");
  const dstEnv = path.join(userDir, ".env");
  if (!fs.existsSync(dstEnv) && fs.existsSync(srcEnv) && fs.statSync(srcEnv).size > 0) {
    fs.copyFileSync(srcEnv, dstEnv);
  }
  // 启动时把 userData/.env 同步回 resources（NSIS 升级可能覆盖 resources/.env）
  if (fs.existsSync(dstEnv) && fs.statSync(dstEnv).size > 0) {
    fs.copyFileSync(dstEnv, srcEnv);
  }

  // data/：junction 指向 userData，登录态(store.json)/历史跨升级保留
  // 操作前先备份 userData 现有数据，防止任何意外覆盖
  backupDirIfNeeded(path.join(userDir, "data"));
  ensureJunction(path.join(userDir, "data"), path.join(NETDISK_DIR, "data"));
  log("netdisk 数据已重定向到 userData:", userDir);
}

// 退出前把运行时可能修改过的 resources/.env 同步回 userData，确保下次启动不丢
function syncNetdiskEnvBack() {
  if (!app.isPackaged) return;
  const srcEnv = path.join(NETDISK_DIR, ".env");
  const dstEnv = path.join(app.getPath("userData"), "netdisk-hub", ".env");
  try {
    if (fs.existsSync(srcEnv) && fs.statSync(srcEnv).size > 0) {
      fs.mkdirSync(path.dirname(dstEnv), { recursive: true });
      fs.copyFileSync(srcEnv, dstEnv);
      log("netdisk .env 已同步回 userData");
    }
  } catch (e) {
    log("sync .env back failed:", e.message);
  }
}

// ── 单实例锁（替代原 Tkinter 单实例锁）──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

function log(...args) {
  console.log("[tools-hub]", ...args);
}

function startChild(cfg) {
  if (!fs.existsSync(cfg.script)) {
    log(`子进程脚本不存在，跳过 ${cfg.key}: ${cfg.script}`);
    return;
  }
  log(`启动子进程 ${cfg.key} -> ${cfg.script}`);
  const proc = fork(cfg.script, [], {
    cwd: cfg.cwd,
    env: cfg.env,
    execPath: NODE_BIN, // 用打包内置 node 或系统 node 运行子进程，避免依赖 electron 当 node
    silent: false, // 子进程 stdout/stderr 直接继承到主进程日志
    windowsHide: true, // 打包/开发都隐藏子进程控制台窗口，避免两个黑框
  });
  cfg.proc = proc;
  cfg.running = true;
  cfg.attempts += 1;

  proc.on("message", (m) => {
    // 子进程可经 IPC 主动上报（预留）
    log(`[${cfg.key}] msg:`, m);
  });
  proc.on("exit", (code, signal) => {
    cfg.running = false;
    cfg.proc = null;
    log(`子进程 ${cfg.key} 退出 code=${code} signal=${signal}`);
    pushStatus();
    if (quitting) return;
    if (cfg.attempts > MAX_RESTART) {
      log(`子进程 ${cfg.key} 重启次数超限，停止重试`);
      return;
    }
    // 延迟 2s 重启，避免崩溃循环
    setTimeout(() => startChild(cfg), 2000);
  });
  proc.on("error", (e) => {
    log(`子进程 ${cfg.key} error:`, e.message);
  });
  pushStatus();
}

function stopAllChildren() {
  quitting = true;
  for (const cfg of Object.values(CHILDREN)) {
    if (cfg.proc) {
      try {
        cfg.proc.kill("SIGTERM");
      } catch (e) {
        /* ignore */
      }
      cfg.proc = null;
      cfg.running = false;
    }
  }
}

function statusPayload() {
  const out = {};
  for (const cfg of Object.values(CHILDREN)) {
    out[cfg.key] = { name: cfg.name, running: cfg.running, url: cfg.url };
  }
  return out;
}

function pushStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status", statusPayload());
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    title: "工具箱 ToolsHub",
    frame: false, // 方案A：去掉系统标题栏，改用自定义标题栏（含最小化/最大化/关闭）
    show: false, // 等页面 ready 后再显示，减少启动黑屏
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // 允许在壳体内使用 <webview> 内嵌工具页面
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });
  // ── 关闭前确认：用自定义 HTML 弹窗（玻璃拟态），不用系统原生对话框 ──
  mainWindow.on("close", (e) => {
    if (allowClose || confirmedClose) return;
    e.preventDefault();
    // 通知渲染进程弹出自定义确认框；用户点“确认关闭”会经 confirm-quit IPC 真正关闭
    mainWindow.webContents.send("request-quit-confirm");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── 自动更新状态推送给渲染进程 ──
function sendUpdate(state, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-status", { state, ...extra });
  }
}

function setupAutoUpdater() {
  // 默认不自动下载，等用户点击"检测更新"再开始
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => sendUpdate("checking"));
  autoUpdater.on("update-available", (info) => {
    sendUpdate("available", { version: info.version });
    // autoDownload=false 避免启动时静默下载；用户点击"检测更新"就是希望下载，
    // 所以发现新版本后立即手动开始下载。
    autoUpdater.downloadUpdate().catch((e) => {
      log("download-update error", e.message);
      sendUpdate("error", { message: e.message });
    });
  });
  autoUpdater.on("update-not-available", () => sendUpdate("not-available"));
  autoUpdater.on("download-progress", (p) =>
    sendUpdate("progress", { percent: p.percent, bytesPerSecond: p.bytesPerSecond })
  );
  autoUpdater.on("update-downloaded", (info) =>
    sendUpdate("downloaded", { version: info.version })
  );
  autoUpdater.on("error", (err) => sendUpdate("error", { message: err.message }));
}

// ── IPC ──
ipcMain.handle("get-version", () => app.getVersion());
ipcMain.handle("get-status", () => statusPayload());
ipcMain.handle("get-webview-preload", () => WEBVIEW_PRELOAD);
ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择封面图片存放目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) {
    return { dir: "" };
  }
  return { dir: result.filePaths[0] };
});
ipcMain.handle("check-update", async () => {
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log("check-update error", e.message);
    sendUpdate("error", { message: e.message });
    throw e;
  }
});
ipcMain.handle("install-update", () => {
  allowClose = true; // 更新安装时跳过关闭确认
  autoUpdater.quitAndInstall(false, true);
});
// ── 退出确认：渲染进程自定义弹窗点“确认关闭”后调用，真正关闭窗口 ──
ipcMain.handle("confirm-quit", () => {
  confirmedClose = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
// ── 自定义标题栏的窗口控制 ──
ipcMain.handle("window-control", (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === "close") win.close(); // 触发 close 事件→确认框
});

app.whenReady().then(() => {
  // 去掉 Electron 默认菜单栏，避免顶部出现 File/Edit/View 等系统菜单，保持工具壳体风格统一
  Menu.setApplicationMenu(null);
  createMainWindow();
  startChild(CHILDREN.kdocs);
  relocateNetdiskData();
  startChild(CHILDREN.netdisk);
  setupAutoUpdater();
  // 子进程启动需要一点时间，稍后推一次状态
  setTimeout(pushStatus, 1500);
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  // Windows 上关闭所有窗口即退出
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  syncNetdiskEnvBack();
  stopAllChildren();
});

app.on("quit", () => {
  stopAllChildren();
});
