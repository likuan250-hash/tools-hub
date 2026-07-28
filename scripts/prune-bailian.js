// 只复制 bailian-cli 的「完整依赖闭包」（含其内部嵌套的
// bailian-cli-commands/-core/-runtime 及公共依赖）到 resources/bin/node_modules。
// 不要复制整个全局 node_modules（~500M，含 @mermaid-js/mcporter/docx/@wecom 等无关包），
// 否则安装包会凭空多出近 500M。
//
// 本地：BAILIAN_SRC 默认指向本机 WorkBuddy 自带 node 的全局 node_modules/bailian-cli。
// CI：通常无该路径，脚本跳过，kdocs 降级（仅介绍/大小/封面缺失，其余正常）。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "resources/bin/node_modules/bailian-cli");
const SRC = process.env.BAILIAN_SRC ||
  "C:/Users/123/.workbuddy/binaries/node/versions/22.22.2/node_modules/bailian-cli";

function duDir(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch { /* ignore */ }
    }
  }
  return total;
}

if (fs.existsSync(path.join(DEST, "dist/bailian.mjs"))) {
  console.log("[prune-bailian] already present, skip (remove dir to force rebuild)");
  process.exit(0);
}
if (!fs.existsSync(SRC)) {
  console.log("[prune-bailian] BAILIAN_SRC not found, skip -> kdocs will degrade without bl:");
  console.log("               " + SRC);
  process.exit(0);
}
fs.cpSync(SRC, DEST, { recursive: true });
const mb = (duDir(DEST) / 1048576).toFixed(1);
console.log(`[prune-bailian] copied bailian-cli closure -> ${DEST} (${mb} MB)`);
