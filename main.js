// tools-hub 主进程（Electron）
// 职责：单实例锁、fork 四个 node 子进程(kdocs/netdisk/biliup/material)、原生文件对话框、状态推送、看门狗、自动更新。
// 启动后渲染进程显示入口页；点击卡片后在同一窗口内以 <webview> 标签打开工具。
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, net, session } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const { fork, spawnSync } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");

// ── 更新/数据包网络：GitHub 相关域名绕过系统代理直连 ──
// 背景：系统代理（WinINET 127.0.0.1:7990）对 GitHub 的 TLS 协商不稳定，
// 曾报 net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH 导致检查更新失败；GitHub 直连实测稳定。
// 仅绕过 GitHub 域名，其余域名仍走系统代理，不影响 YouTube 等依赖代理的功能。
app.commandLine.appendSwitch(
  "proxy-bypass-list",
  "github.com;api.github.com;*.githubusercontent.com;*.githubassets.com;*.github.io",
);

// 主进程中不依赖 Electron 运行时的纯函数（safeStr / copyDir），抽到 lib 以便独立单测。
const { safeStr, copyDir } = require("./lib/host-utils");

const RES = process.resourcesPath; // 开发时=项目根，打包后=resources 目录
const KDOCS_DIR = path.join(RES, "kdocs-tool");
const NETDISK_DIR = path.join(RES, "netdisk-hub");
const BILIUP_DIR = path.join(RES, "biliup-hub");
const MATERIAL_DIR = path.join(RES, "material-hub");
const RESOLVE_DIR = path.join(RES, "resolve-hub");

// Node 运行时：打包后自带 resources/node/node.exe；开发时回退系统 PATH 的 node
const NODE_BIN = fs.existsSync(path.join(RES, "node", "node.exe"))
  ? path.join(RES, "node", "node.exe")
  : "node";

// 启动令牌：随机生成，注入子进程环境变量；子服务在 /api/version 回显。
// 主进程据此校验"占用本端口的确实是我们自己的服务"，可检测端口被其他进程抢占/伪造(本地安全)。
const BOOT_TOKEN = crypto.randomBytes(16).toString("hex");

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
      TOOLSHUB_VERSION: app.getVersion(),
      KDOCS_PORT: "3599",
    }),
    proc: null,
    running: false,
    attempts: 0,
    startedAt: 0,
    lastError: null,
  },
  netdisk: {
    key: "netdisk",
    name: "网盘转存中转",
    script: path.join(NETDISK_DIR, "server.js"),
    cwd: NETDISK_DIR,
    url: "http://localhost:3000",
    env: Object.assign({}, process.env, {
      TOOLSHUB_VERSION: app.getVersion(),
      PORT: "3000",
      PLAYWRIGHT_BROWSERS_PATH: "0",
    }),
    proc: null,
    running: false,
    attempts: 0,
    startedAt: 0,
    lastError: null,
  },
  biliup: {
    key: "biliup",
    name: "B站自动投稿",
    script: path.join(BILIUP_DIR, "server.js"),
    cwd: BILIUP_DIR,
    url: "http://localhost:3600",
    env: Object.assign({}, process.env, {
      TOOLSHUB_VERSION: app.getVersion(),
      BILIUP_PORT: "3600",
    }),
    proc: null,
    running: false,
    attempts: 0,
    startedAt: 0,
    lastError: null,
  },
  material: {
    key: "material",
    name: "素材搜集",
    script: path.join(MATERIAL_DIR, "server.js"),
    cwd: MATERIAL_DIR,
    url: "http://localhost:3700",
    env: Object.assign({}, process.env, {
      TOOLSHUB_VERSION: app.getVersion(),
      MATERIAL_PORT: "3700",
      // 素材落盘根目录（不存在时由子进程自动 mkdir -p，见 lib/name.js）。
      // 默认 E:\素材\ 与历史一致；可用环境变量 TOOLSHUB_MATERIAL_DIR 覆盖（换盘符/换机器时无需改代码）。
      MATERIAL_OUTPUT_DIR: process.env.TOOLSHUB_MATERIAL_DIR || "E:\\素材\\",
    }),
    proc: null,
    running: false,
    attempts: 0,
    startedAt: 0,
    lastError: null,
  },
  resolve: {
    key: "resolve",
    name: "达芬奇剪辑",
    script: path.join(RESOLVE_DIR, "server.js"),
    cwd: RESOLVE_DIR,
    url: "http://localhost:3800",
    env: Object.assign({}, process.env, {
      TOOLSHUB_VERSION: app.getVersion(),
      PORT: "3800",
      // 达芬奇自动化配置（与 scripts/resolve-auto/config.js 默认值同源，可用环境变量覆盖）
      RESOLVE_MATERIAL_ROOT: process.env.RESOLVE_MATERIAL_ROOT || "E:\\素材",
      // ffmpeg/ffprobe 复用 material-hub 内置二进制（开发/打包路径均可用）
      RESOLVE_FFMPEG: fs.existsSync(
        path.join(
          RES,
          "material-hub",
          "node_modules",
          "@ffmpeg-installer",
          "win32-x64",
          "ffmpeg.exe",
        ),
      )
        ? path.join(
            RES,
            "material-hub",
            "node_modules",
            "@ffmpeg-installer",
            "win32-x64",
            "ffmpeg.exe",
          )
        : "ffmpeg",
      RESOLVE_FFPROBE: fs.existsSync(
        path.join(
          RES,
          "material-hub",
          "node_modules",
          "@ffprobe-installer",
          "win32-x64",
          "ffprobe.exe",
        ),
      )
        ? path.join(
            RES,
            "material-hub",
            "node_modules",
            "@ffprobe-installer",
            "win32-x64",
            "ffprobe.exe",
          )
        : "ffprobe",
    }),
    proc: null,
    running: false,
    attempts: 0,
    startedAt: 0,
    lastError: null,
  },
};

const MAX_RESTART = 5;
let mainWindow = null;
let quitting = false;
let allowClose = false; // 更新安装等场景直接关闭，跳过确认
let confirmedClose = false; // 用户已在确认框点了“确认关闭”

// ── 资源优化：子服务随子页面生命周期启停 ──
// 打开工具标签 → 启动对应子服务；关闭标签 → 立即停止对应子服务；再打开自动重启。
function stopChild(cfg) {
  if (!cfg.proc) return;
  cfg.stopRequested = true;
  log(`停止子进程 ${cfg.key}（标签已关闭）`);
  try {
    cfg.proc.kill("SIGTERM");
  } catch (e) {
    /* 已退出 */
  }
}

// ── 主题单一真源：主进程缓存工具箱当前主题，供 webview-preload 主动拉取 ──
let currentTheme = "dark";

// ── 打包后把 netdisk 可变数据(.env / data/)重定向到 userData，升级不丢 ──
// resources/ 在 NSIS 升级时会被清空重装，而 app.getPath('userData') 跨版本保留。
// 方案(已弃用 junction)：曾经用目录 junction 把 resources/netdisk-hub/data 指向 userData，
//   但 NSIS 升级清理安装目录时会删除 junction 重解析点，连带真实数据被误清 —— 这就是
//   「升级后网盘全变未连接」反复修不好的根因。
// 现方案：主进程在 fork 子进程时经环境变量 NETDISK_DATA_DIR / KDOCS_DATA_DIR / BILIUP_DATA_DIR 注入
//   userData 下的真实目录，netdisk 直接读写该目录（见 src/store.js / src/xunlei*.js），
//   resources 下不再留任何 data 引用，升级清理安装目录时数据毫发无损。
function relocateNetdiskData() {
  if (!app.isPackaged) return; // 仅打包后生效，开发模式不动源码目录
  const userDir = path.join(app.getPath("userData"), "netdisk-hub");
  const userDataDir = path.join(userDir, "data");
  fs.mkdirSync(userDataDir, { recursive: true });

  // 兜底迁移：userData 数据为空、且安装目录残留真实 data（非 junction）时，一次性拷过去。
  // 正常升级路径下数据已在 userData，本分支不触发；仅防极端情况下数据落在安装目录。
  const srcData = path.join(NETDISK_DIR, "data");
  const userHasData = fs.readdirSync(userDataDir).some((n) => {
    const p = path.join(userDataDir, n);
    const st = fs.statSync(p);
    return st.isDirectory() || st.size > 10;
  });
  if (
    !userHasData &&
    fs.existsSync(srcData) &&
    fs.statSync(srcData).isDirectory() &&
    !fs.lstatSync(srcData).isSymbolicLink()
  ) {
    try {
      copyDir(srcData, userDataDir);
      log("已从安装目录迁移 netdisk 数据到 userData:", userDataDir);
    } catch (e) {
      log("迁移失败:", e.message);
    }
  } else {
    log("netdisk 数据目录:", userDataDir);
  }

  // .env：以 userData 为准。安装包内不含 .env（extraResources filter 排除 !**/.env，
  // 防止公开 Release 携带本机凭证），「从 resources 迁移」分支只覆盖开发/手动拷贝场景；
  // 用户自定义 .env 应放在 userData/netdisk-hub/.env，启动时同步到 resources 供子进程读取。
  const srcEnv = path.join(NETDISK_DIR, ".env");
  const dstEnv = path.join(userDir, ".env");
  if (!fs.existsSync(dstEnv) && fs.existsSync(srcEnv) && fs.statSync(srcEnv).size > 0) {
    fs.copyFileSync(srcEnv, dstEnv);
  }
  // 启动时把 userData/.env 同步回 resources（子进程 cwd 为 resources/netdisk-hub，只读该处 .env）
  if (fs.existsSync(dstEnv) && fs.statSync(dstEnv).size > 0) {
    fs.copyFileSync(dstEnv, srcEnv);
  }
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

// ── 日志：同时输出到控制台与 userData/tools-hub.log（带滚动）──
// 打包后 stdout 无落盘，用户机器出问题时这边完全没日志可查；现改为持久化。
let _logFile = null;
function getLogFile() {
  if (_logFile === null) {
    try {
      _logFile = path.join(app.getPath("userData"), "tools-hub.log");
    } catch (e) {
      _logFile = false;
    }
  }
  return _logFile || null;
}
function log(...args) {
  const line = "[" + new Date().toISOString() + "] [tools-hub] " + args.map(safeStr).join(" ");
  console.log("[tools-hub]", ...args);
  const f = getLogFile();
  if (!f) return;
  try {
    try {
      const st = fs.statSync(f);
      if (st.size > 5 * 1024 * 1024) {
        // >5MB 滚动：保留一份 .1 备份
        fs.copyFileSync(f, f + ".1");
        fs.writeFileSync(f, "");
      }
    } catch (e) {
      /* 首次写入 */
    }
    fs.appendFileSync(f, line + "\n");
  } catch (e) {
    /* 日志失败不影响主流程 */
  }
}

// 启动后清理 userData/netdisk-hub 下残留的过期备份目录(如 *.backup-*)，防止长期堆积占盘
function cleanupStaleBackups() {
  try {
    const dir = path.join(app.getPath("userData"), "netdisk-hub");
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    for (const n of fs.readdirSync(dir)) {
      if (!/\.backup-/.test(n)) continue;
      const p = path.join(dir, n);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAge) fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {}
    }
  } catch (e) {
    log("cleanupStaleBackups error:", e.message);
  }
}

// 端口防抢占检测：拉取子服务 /api/version，校验 bootToken 是否匹配我们注入的令牌。
// 不匹配说明 127.0.0.1:PORT 被其他进程抢占/伪造(本地恶意进程场景)，记录安全告警。
function verifyChildBoot(cfg) {
  const req = http.get(cfg.url + "/api/version", (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      try {
        const j = JSON.parse(d);
        if (j.bootToken && j.bootToken !== BOOT_TOKEN) {
          log(
            "⚠️ 安全警告：" +
              cfg.key +
              " 端口 " +
              cfg.url +
              " 返回的 bootToken 不匹配，疑似端口被其他进程抢占/伪造，请检查本机是否有可疑进程。",
          );
        }
      } catch (e) {
        /* 响应非 JSON，忽略 */
      }
    });
  });
  req.on("error", () => {
    /* 子进程未起/暂不可达，不判违规 */
  });
  req.setTimeout(3000, () => req.destroy());
}

// ── #5 健康看门狗辅助 ──
// 探活：访问 /api/version，200 视为存活。
// 注意：必须用 /api/version 而非 /api/health —— kdocs-tool 仅实现 /api/version，
// 若用 /api/health 会因其返回 404 被误判为“已死”并被看门狗每 30s 重启一次（违反“不影响网盘/金山”）。
// 三个子服务(kdocs/netdisk/biliup)均实现 /api/version 且回显 bootToken，是跨服务统一的探活基线。
function healthCheck(cfg) {
  return new Promise((resolve) => {
    const req = http.get(cfg.url + "/api/version", (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 端口占用探测（#5 D：EADDRINUSE 友好提示）。
// 同样用 /api/version：只要端口上有进程在监听就返回响应，足以判断“端口被占用”。
function isPortInUse(url) {
  return new Promise((resolve) => {
    const req = http.get(url + "/api/version", (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 端口归属探测（#5 B：启动前清理）。返回 'ours' | 'foreign' | 'empty'。
function probeChildPort(cfg) {
  return new Promise((resolve) => {
    const req = http.get(cfg.url + "/api/version", (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          resolve(j.bootToken === BOOT_TOKEN ? "ours" : "foreign");
        } catch (e) {
          resolve("foreign");
        }
      });
    });
    req.on("error", () => resolve("empty"));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve("empty");
    });
  });
}

function startChild(cfg) {
  if (!fs.existsSync(cfg.script)) {
    log(`子进程脚本不存在，跳过 ${cfg.key}: ${cfg.script}`);
    return;
  }
  cfg.stopRequested = false;
  cfg.lastActive = Date.now();
  log(`启动子进程 ${cfg.key} -> ${cfg.script}`);
  // 数据目录 env：仅打包后注入。netdisk 读 NETDISK_DATA_DIR，kdocs 读 NETDISK_DATA_DIR(夸克 cookie) + KDOCS_DATA_DIR(browse IPC)，
  // biliup 读 BILIUP_DATA_DIR（cookies/数据，与投稿上传同目录）。
  // 开发模式不注入，子进程回退到各自的安装目录 data/，保持开发兼容。
  const dataEnv = app.isPackaged
    ? {
        NETDISK_DATA_DIR: path.join(app.getPath("userData"), "netdisk-hub", "data"),
        KDOCS_DATA_DIR: path.join(app.getPath("userData"), "kdocs-tool", "data"),
        BILIUP_DATA_DIR: path.join(app.getPath("userData"), "biliup-hub", "data"),
      }
    : {};
  // #7 透传系统代理环境变量到 fork 子进程。
  //   背景：kdocs-tool 等子进程是独立 Node 进程，不读系统代理/Windows 证书库，
  //   若这里不显式继承 process.env 的代理变量，用户在系统/客户端配的 HTTP 代理对子进程无效，
  //   导致 Wikipedia / Wikidata / 百度百科 等被墙数据源依旧连不上。
  //   （kdocs-tool/lib/proxyHttp.js 会读取这些变量走 CONNECT 隧道。）
  const PROXY_ENV_KEYS = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const proxyEnv = {};
  for (const k of PROXY_ENV_KEYS) {
    if (process.env[k]) proxyEnv[k] = process.env[k];
  }
  const childEnv = Object.assign({}, cfg.env, dataEnv, proxyEnv, { BOOT_TOKEN: BOOT_TOKEN });
  // #6 注入资源目录，供 fork 子进程解析打包内置的 biliup.exe（子进程无 process.resourcesPath）。
  if (RES) childEnv.TOOLSHUB_RESOURCES_DIR = RES;

  const proc = fork(cfg.script, [], {
    cwd: cfg.cwd,
    env: childEnv,
    execPath: NODE_BIN, // 用打包内置 node 或系统 node 运行子进程，避免依赖 electron 当 node
    silent: false, // 子进程 stdout/stderr 直接继承到主进程日志
    windowsHide: true, // 打包/开发都隐藏子进程控制台窗口，避免两个黑框
  });
  cfg.proc = proc;
  cfg.running = true;
  cfg.startedAt = Date.now();
  cfg.attempts += 1;
  cfg.lastError = null;

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
    if (cfg.stopRequested) {
      // 标签关闭停止（非崩溃）：重置重启计数，避免反复拉起的次数被耗尽
      cfg.stopRequested = false;
      cfg.attempts = 0;
      return;
    }
    // #5 D：端口占用友好提示（EADDRINUSE 探活）。仅异常退出时探活。
    if (code && code !== 0) {
      isPortInUse(cfg.url)
        .then((used) => {
          cfg.lastError = used
            ? `启动失败：端口被占用 (EADDRINUSE)，请检查 ${cfg.url} 是否被其他进程占用`
            : `进程异常退出 code=${code}`;
          pushStatus();
        })
        .catch(() => {});
    } else {
      cfg.lastError = null;
    }
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
  // 子进程起来后校验端口归属(端口防抢占检测)
  setTimeout(() => verifyChildBoot(cfg), 3000);
  pushStatus();
}

// ── #5 C：退出前强制杀进程（SIGTERM 后延迟 3s，仍存活则 SIGKILL / taskkill）──
function stopAllChildren() {
  quitting = true;
  for (const cfg of Object.values(CHILDREN)) {
    if (cfg.proc) {
      try {
        cfg.proc.kill("SIGTERM");
      } catch (e) {
        /* ignore */
      }
    }
  }
  // 延迟 3s 后强制清理仍未退出的幽灵进程，避免升级/退出后残留占用端口。
  setTimeout(() => {
    for (const cfg of Object.values(CHILDREN)) {
      if (cfg.proc) {
        try {
          if (process.platform === "win32") {
            try {
              spawnSync("taskkill", ["/F", "/PID", String(cfg.proc.pid)], { windowsHide: true });
            } catch (e) {
              /* ignore */
            }
          } else {
            cfg.proc.kill("SIGKILL");
          }
        } catch (e) {
          /* ignore */
        }
        cfg.proc = null;
        cfg.running = false;
      }
    }
  }, 3000);
}

// ── #5 A：周期健康看门狗（每 30s 探活，发现 dead 自动重启）──
let watchdogTimer = null;
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    if (quitting) return;
    for (const cfg of Object.values(CHILDREN)) {
      // 仅在“认为运行中”时探活；退出后的重启由 proc 'exit' 处理器负责，避免双重重启。
      if (!cfg.running) continue;
      // 刚启动 10s 内端口可能尚未就绪，跳过以免误判。
      if (Date.now() - (cfg.startedAt || 0) < 10000) continue;
      const alive = await healthCheck(cfg).catch(() => false);
      if (alive) continue;
      // 探活失败：进程可能已崩溃但未触发 exit（幽灵进程）→ 强制重启。
      log(`看门狗：检测到 ${cfg.key} 无响应，尝试重启`);
      cfg.running = false;
      if (cfg.proc) {
        try {
          cfg.proc.kill("SIGKILL");
        } catch (e) {}
        cfg.proc = null;
      }
      if (cfg.attempts > MAX_RESTART) {
        log(`看门狗：${cfg.key} 重启次数超限，停止`);
        continue;
      }
      // #5 B：启动前探测端口，避免误杀其它服务。
      const state = await probeChildPort(cfg);
      if (state === "ours") {
        // 端口仍被“我们自己”的前一个实例占用 → 视为存活并复用，不再拉新实例。
        log(`${cfg.key} 端口仍被自身占用，复用已有实例`);
        cfg.running = true;
        continue;
      }
      if (state === "foreign") {
        log(
          `⚠️ ${cfg.key} 端口被其它进程占用（bootToken 不匹配，疑似端口抢占/伪造）；未自动清理以免误杀`,
        );
        // 不重复拉起：端口被外来进程占用时，新实例必然 EADDRINUSE 反复失败，
        // 只会浪费重试次数并刷日志。保持 running=false，等下一轮看门狗再探。
        continue;
      }
      startChild(cfg);
    }
  }, 30000);
  if (watchdogTimer.unref) watchdogTimer.unref();
}

function statusPayload() {
  const out = {};
  for (const cfg of Object.values(CHILDREN)) {
    out[cfg.key] = {
      name: cfg.name,
      running: cfg.running,
      url: cfg.url,
      lastError: cfg.lastError || null,
    };
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
      sandbox: true, // 渲染进程沙箱化：preload 仅用 contextBridge/ipcRenderer，兼容沙箱
      webviewTag: true, // 允许在壳体内使用 <webview> 内嵌工具页面
    },
  });
  // 打包后用构建期内联版（style.inline.css，彻底不依赖 @import），dev 用 index.html
  const rendererEntry = app.isPackaged
    ? path.join(__dirname, "renderer", "index.inline.html")
    : path.join(__dirname, "renderer", "index.html");
  mainWindow.loadFile(rendererEntry);
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
  // 关闭差分下载：本地缓存（installer.exe/blockmap）跨版本错配时差分必失败，
  // electron-updater 会回退全量重下，表现为「下两遍、第二遍很慢」。只下完整包一次最稳。
  autoUpdater.disableDifferentialDownload = true;
  // 把 electron-updater 内部日志写入 tools-hub.log，便于日后排查更新问题
  const updaterLog = (...args) => log("[updater]", ...args);
  autoUpdater.logger = {
    info: updaterLog,
    warn: updaterLog,
    error: updaterLog,
    debug: updaterLog,
  };

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
    sendUpdate("progress", { percent: p.percent, bytesPerSecond: p.bytesPerSecond }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    sendUpdate("downloaded", { version: info.version }),
  );
  autoUpdater.on("error", (err) => sendUpdate("error", { message: err.message }));
}

// ── 离线数据包静默增量更新（方案 A：启动后台拉取，失败静默回退内置）──
// 数据包 data-pack.json（中文名→英文名 override + 英文名→AppID）随 Release 发布（release.sh 上传为资产），
// App 启动时从 releases/latest/download/data-pack.json 拉取，版本更高则写入 {userData}/kdocs-tool/data/ 缓存；
// kdocs-tool 子进程（KDOCS_DATA_DIR 指向该目录）下次查询自动用新数据（见 kdocs-tool/lib/datapack.js）。
// 用 Electron net.fetch：认系统代理 + 系统证书库（比子进程代理感知层更通用）。失败/超时/版本非法一律静默。
async function refreshDataPack() {
  try {
    const url =
      "https://github.com/likuan250-hash/tools-hub/releases/latest/download/data-pack.json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "ToolsHub" },
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const txt = await res.text();
    const j = JSON.parse(txt);
    if (!j || typeof j.version !== "number" || j.version < 1) return;
    const dir = path.join(app.getPath("userData"), "kdocs-tool", "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "data-pack.json"), txt, "utf8");
    log("data-pack 更新成功 v" + j.version);
  } catch (e) {
    log("data-pack 拉取失败（静默回退内置）:", e && e.message ? e.message : e);
  }
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
ipcMain.handle("pick-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择视频文件",
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4"] }],
  });
  if (result.canceled || !result.filePaths.length) {
    return { filePath: "" };
  }
  return { filePath: result.filePaths[0] };
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
// ── 系统默认浏览器打开外部链接（金山文档入口等）──
ipcMain.handle("open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});
// ── 在文件管理器中显示并选中文件（素材搜集产物卡片点击）──
ipcMain.handle("reveal-in-folder", (_e, p) => {
  if (typeof p !== "string" || !p) return false;
  shell.showItemInFolder(p);
  return true;
});
// ── 主题单一真源：webview 内嵌页主动拉取 / 渲染进程通知当前主题 ──
ipcMain.handle("get-theme", () => currentTheme);
ipcMain.handle("set-theme", (_e, t) => {
  if (t === "light" || t === "dark" || t === "cosmic" || t === "comic") currentTheme = t;
});
// ── 资源优化：入口页打开/切换工具标签时，按需拉起对应子服务（空闲停止后可自动重启）──
ipcMain.handle("tool-open", (_e, key) => {
  const cfg = CHILDREN[key];
  if (!cfg) return { ok: false };
  cfg.lastActive = Date.now();
  if (!cfg.running && !cfg.proc) {
    cfg.attempts = 0;
    startChild(cfg);
  }
  return { ok: true };
});
// 等待子服务就绪（冷启动约 1~3s），供入口页创建 webview 前等待，避免首载失败白屏
ipcMain.handle("tool-ready", (_e, key, timeoutMs) => {
  const cfg = CHILDREN[key];
  if (!cfg) return false;
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000);
  return new Promise((resolve) => {
    const poll = async () => {
      const ok = await healthCheck(cfg).catch(() => false);
      if (ok) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 400);
    };
    poll();
  });
});
// 关闭工具标签 → 立即停止对应子服务（再打开时 tool-open 自动拉起）
ipcMain.handle("tool-close", (_e, key) => {
  const cfg = CHILDREN[key];
  if (!cfg) return { ok: false };
  stopChild(cfg);
  return { ok: true };
});

app.whenReady().then(async () => {
  // 去掉 Electron 默认菜单栏，避免顶部出现 File/Edit/View 等系统菜单，保持工具壳体风格统一
  Menu.setApplicationMenu(null);
  // 启动时清一次磁盘缓存：renderer 外链 css/js 升级后仍可能命中旧缓存（皮肤/进度条改动不生效的根因）
  try {
    await session.defaultSession.clearCache();
  } catch (e) {
    /* 清缓存失败不影响启动 */
  }
  createMainWindow();
  relocateNetdiskData();
  cleanupStaleBackups();
  setupAutoUpdater();
  // 数据包静默增量更新（后台 fire-and-forget，失败静默回退内置，不阻塞启动）
  refreshDataPack().catch(() => {});
  // 子进程启动需要一点时间，稍后推一次状态
  setTimeout(pushStatus, 1500);
  // #5 A：启动健康看门狗（biliup 中途崩溃会自动拉起，网盘/金山同样受益且不受影响）
  startWatchdog();
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
