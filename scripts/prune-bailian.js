// 准备 bailian-cli（bl 命令）到 resources/bin/node_modules。
// 策略：
//  1) 若目标已存在，跳过（删目录可强制重建）
//  2) 本地有 BAILIAN_SRC（开发机全局 node_modules/bailian-cli），直接复制
//  3) 否则执行 npm install bailian-cli（CI/无本地源时使用）
//  4) 都失败则 kdocs 降级（仅 AI 介绍/大小/封面缺失，其余正常）
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEST_DIR = path.join(ROOT, "resources/bin/node_modules");
const DEST = path.join(DEST_DIR, "bailian-cli");
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

function bailianPresent() {
  return fs.existsSync(path.join(DEST, "dist/bailian.mjs"));
}

function copyLocal() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  fs.cpSync(SRC, DEST, { recursive: true, force: true });
  const mb = (duDir(DEST) / 1048576).toFixed(1);
  console.log(`[prune-bailian] copied local bailian-cli -> ${DEST} (${mb} MB)`);
}

function installFromNpm() {
  console.log("[prune-bailian] local source not found, trying npm install bailian-cli...");
  fs.mkdirSync(DEST_DIR, { recursive: true });
  // 在 resources/bin 下直接安装，生成 node_modules/bailian-cli 及其依赖
  const binDir = path.join(ROOT, "resources/bin");
  const tmpJson = path.join(binDir, "package.json");
  const hadJson = fs.existsSync(tmpJson);
  if (!hadJson) {
    fs.writeFileSync(tmpJson, JSON.stringify({ name: "tools-hub-bundled-bin", version: "0.0.0", private: true }, null, 2));
  }
  try {
    execSync("npm install bailian-cli --no-save --omit=dev", {
      cwd: binDir,
      stdio: "inherit",
      timeout: 120000,
    });
  } finally {
    // 清理临时 manifest，避免打包进多余文件
    try { fs.unlinkSync(tmpJson); } catch {}
    try { fs.unlinkSync(path.join(binDir, "package-lock.json")); } catch {}
  }
  if (!bailianPresent()) {
    throw new Error("npm install completed but bailian-cli/dist/bailian.mjs not found");
  }
  const mb = (duDir(DEST) / 1048576).toFixed(1);
  console.log(`[prune-bailian] installed bailian-cli from npm -> ${DEST} (${mb} MB)`);
}

if (bailianPresent()) {
  console.log("[prune-bailian] already present, skip (remove dir to force rebuild)");
  process.exit(0);
}

try {
  if (fs.existsSync(SRC)) {
    copyLocal();
  } else {
    installFromNpm();
  }
} catch (e) {
  console.log("[prune-bailian] FAILED:", e.message);
  console.log("               kdocs will degrade without bl (AI intro/size/cover disabled)");
  process.exit(0); // 不要让构建因此中断
}
