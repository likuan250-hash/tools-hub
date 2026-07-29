// 构建前准备运行时资源：
//  1) 确保 resources/node 与 resources/bin 存在（electron-builder extraResources 不能指向缺失目录）
//  2) 准备 node.exe：优先用 NODE_SRC；否则尝试当前进程 execPath（setup-node/本机 node）
//  3) 准备 bailian-cli：见 prune-bailian.js（本地复制 或 npm install 兜底）
// 真实二进制（node.exe / bl 依赖）均被 .gitignore 忽略，不进 git，仅本地/CI 准备。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

for (const d of ["resources/node", "resources/bin"]) {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
}

const NODE_DEST = path.join(__dirname, "../resources/node/node.exe");

function findNodeSrc() {
  const env = process.env.NODE_SRC;
  if (env && fs.existsSync(env)) return env;
  const local = "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2/node.exe";
  if (fs.existsSync(local)) return local;
  // CI/setup-node 会把 node 加到 PATH，process.execPath 就是 node.exe
  if (process.execPath && /node\.exe$/i.test(process.execPath) && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  return null;
}

const NODE_SRC = findNodeSrc();
if (!fs.existsSync(NODE_DEST) && NODE_SRC) {
  fs.copyFileSync(NODE_SRC, NODE_DEST);
  console.log("[prepare-build] copied node.exe ->", NODE_DEST);
} else if (fs.existsSync(NODE_DEST)) {
  console.log("[prepare-build] node.exe already present, skip");
} else {
  console.log("[prepare-build] no node.exe source found, fork will fall back to system node");
}

// 复制 netdisk-hub/.env（百度/夸克/迅雷凭证与目标目录配置），使其被 extraResources 打包进
// resources/netdisk-hub/.env。CI 包也可由 build.yml 的 secrets.NETDISK_ENV 步骤写入（二者二选一）。
// 注意：netdisk-hub/.gitignore 已忽略 .env，本地副本不会进 git（凭证安全）。
function copyNetdiskEnv() {
  const dest = path.join(ROOT, "netdisk-hub", ".env");
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log("[prepare-build] netdisk-hub/.env already present, skip");
    return;
  }
  const candidates = [
    process.env.NETDISK_ENV_SRC,
    path.join(ROOT, "netdisk-hub", ".env"),
    path.join(ROOT, "..", "netdisk-hub", ".env"),
  ].filter(Boolean);
  for (const src of candidates) {
    if (fs.existsSync(src) && fs.statSync(src).size > 0) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      console.log("[prepare-build] copied netdisk-hub/.env <- " + src);
      return;
    }
  }
  console.log("[prepare-build] no netdisk-hub/.env source; CI 请配 secrets.NETDISK_ENV, 或本地放 .env 后 build");
}

copyNetdiskEnv();

require("./prune-bailian");
console.log("[prepare-build] done");
