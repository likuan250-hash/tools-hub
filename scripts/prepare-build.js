// 构建前确保 resources/node 与 resources/bin 存在（空目录也可被 electron-builder 打包），
// 避免 extraResources 因目录缺失报错。真实 node.exe / bl 资源由本地复制或 CI 准备。
const fs = require("fs");
const path = require("path");
for (const d of ["resources/node", "resources/bin"]) {
  fs.mkdirSync(path.join(__dirname, d), { recursive: true });
}
console.log("[prepare-build] ensured resources/node & resources/bin exist");
