// tools-hub 主进程（Electron）
// 职责：单实例锁、fork 两个 node 子进程(kdocs/netdisk)、原生文件对话框、状态推送、看门狗。
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
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
const toolWindows = {}; // key -> BrowserWindow
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
    width: 880,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: "工具箱 ToolsHub",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// 在工具窗口内加载对应工具（带 preload，使其能用原生对话框）
function openTool(key) {
  const cfg = CHILDREN[key];
  if (!cfg) return;
  if (toolWindows[key] && !toolWindows[key].isDestroyed()) {
    toolWindows[key].focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: cfg.name,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(cfg.url);
  toolWindows[key] = win;
  win.on("closed", () => {
    toolWindows[key] = null;
  });
}

// ── IPC ──
ipcMain.handle("get-status", () => statusPayload());

ipcMain.handle("open-tool", (e, key) => {
  openTool(key);
  return { ok: true };
});

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

// 工具页(fork 出的 server 由 web 调)也可直接请求 picker —— 走同一通道
ipcMain.handle("pick-folder-for", async () => {
  return ipcMain.handlers ? await ipcMain.handlers["pick-folder"]() : { dir: "" };
});

app.whenReady().then(() => {
  createMainWindow();
  startChild(CHILDREN.kdocs);
  startChild(CHILDREN.netdisk);
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
