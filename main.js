// tools-hub 主进程（Electron）
// 职责：单实例锁、fork 两个 node 子进程(kdocs/netdisk)、原生文件对话框、状态推送、看门狗、自动更新。
// 启动后渲染进程显示入口页；点击卡片后在同一窗口内以 <webview> 标签打开工具。
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
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
  autoUpdater.on("update-available", (info) => sendUpdate("available", { version: info.version }));
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
  autoUpdater.quitAndInstall(false, true);
});

app.whenReady().then(() => {
  createMainWindow();
  startChild(CHILDREN.kdocs);
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
  stopAllChildren();
});

app.on("quit", () => {
  stopAllChildren();
});
