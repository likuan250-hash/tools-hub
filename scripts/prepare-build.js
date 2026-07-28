// 构建前准备运行时资源：
//  1) 确保 resources/node 与 resources/bin 存在（electron-builder extraResources 不能指向缺失目录）
//  2) 本地有内置 Node 时复制 node.exe（CI 无则跳过，fork 回退系统 node）
//  3) 复制精简后的 bailian-cli 闭包（见 prune-bailian.js，避免把 ~500M 全局 node_modules 打进包）
// 真实二进制（node.exe / bl 依赖）均被 .gitignore 忽略，不进 git，仅本地/CI 准备。
const fs = require("fs");
const path = require("path");

for (const d of ["resources/node", "resources/bin"]) {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
}

const NODE_SRC = process.env.NODE_SRC ||
  "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2/node.exe";
const NODE_DEST = path.join(__dirname, "../resources/node/node.exe");
if (!fs.existsSync(NODE_DEST) && fs.existsSync(NODE_SRC)) {
  fs.copyFileSync(NODE_SRC, NODE_DEST);
  console.log("[prepare-build] copied node.exe ->", NODE_DEST);
} else if (fs.existsSync(NODE_DEST)) {
  console.log("[prepare-build] node.exe already present, skip");
} else {
  console.log("[prepare-build] no NODE_SRC, skip node.exe (fork will fall back to system node)");
}

require("./prune-bailian");
console.log("[prepare-build] done");
