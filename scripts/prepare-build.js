// 构建前准备运行时资源：
//  1) 确保 resources/node 与 resources/bin 存在（electron-builder extraResources 不能指向缺失目录）
//  2) 准备 node.exe：优先用 NODE_SRC；否则尝试当前进程 execPath（setup-node/本机 node）
//  3) 内置外部二进制：见 prepare-material-bins.js / prepare-biliup-bin.js
// 真实二进制（node.exe / bl 依赖）均被 .gitignore 忽略，不进 git，仅本地/CI 准备。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// 路径一律基于 ROOT（仓库根），不要用 __dirname —— 本文件在 scripts/ 下，
// 用 __dirname 会把目录建到 scripts/resources/*，而 NODE_DEST 指向的是仓库根的
// resources/node/，父目录从未创建，下面的 copyFileSync 必 ENOENT（本地 build 长期崩在这）。
for (const d of ["resources/node", "resources/bin"]) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

const NODE_DEST = path.join(ROOT, "resources/node/node.exe");

function findNodeSrc() {
  // 优先当前运行进程所用的 node.exe（本机/CI/npm run 均可靠，不依赖写死路径）
  if (process.execPath && /node\.exe$/i.test(process.execPath) && fs.existsSync(process.execPath)) {
    return process.execPath;
  }
  const env = process.env.NODE_SRC;
  if (env && fs.existsSync(env)) return env;
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

// ── netdisk .env 说明（重要，勿再「顺手打进去」）──
// package.json 的 extraResources filter 明确排除了 netdisk-hub/**/.env（`!**/.env`），
// 安装包内永远不带任何 .env —— 否则公开 Release 会把本机代理/凭证发给所有下载者。
// 运行时全部配置都有代码内默认值（BAIDU_APP_DIR=/apps/netdisk_hub、QUARK_FOLDER=netdisk_hub、PORT=3000），
// 用户如需自定义 .env，由主进程 main.js 从 userData/netdisk-hub/.env 启动时同步到 resources 再读。
// 本脚本不再做任何 .env 复制。

// ── 构建期内联共享样式 ──
// 根因修复：打包后 asar 内 CSS @import 跨目录('../shared/...')曾整份加载失败，
// 导致 tokens.css（含全部颜色变量与亮/暗主题规则）未生效，界面全黑、主题切换无效。
// 这里在构建期把 shared/tokens.css + shared/macos-motion.css 内联进 renderer，
// 生成 style.inline.css 与 index.inline.html（打包后主进程改用之），
// 运行时彻底不依赖 @import。dev 模式仍走 index.html（@import 在项目目录可正常解析）。
function inlineSharedStyles() {
  const sharedDir = path.join(ROOT, "shared");
  const tkPath = path.join(sharedDir, "tokens.css");
  const mtPath = path.join(sharedDir, "macos-motion.css");
  if (!fs.existsSync(tkPath) || !fs.existsSync(mtPath)) {
    console.log("[prepare-build] shared 样式缺失，跳过内联（dev/异常）");
    return;
  }
  const tk = fs.readFileSync(tkPath, "utf8");
  const mt = fs.readFileSync(mtPath, "utf8");
  const styleSrc = fs.readFileSync(path.join(ROOT, "renderer", "style.css"), "utf8");
  // 去掉 renderer/style.css 顶部对 ../shared/ 的 @import（运行时已内联，避免重复/失败）
  const styleBody = styleSrc
    .split("\n")
    .filter((l) => !/^\s*@import\s+url\(\s*["']?\.\.\/shared\//.test(l))
    .join("\n");
  const bundled =
    "/* === inlined from shared/tokens.css (build-time) === */\n" +
    tk +
    "\n/* === inlined from shared/macos-motion.css (build-time) === */\n" +
    mt +
    "\n/* === renderer/style.css === */\n" +
    styleBody;
  fs.writeFileSync(path.join(ROOT, "renderer", "style.inline.css"), bundled);
  let html = fs.readFileSync(path.join(ROOT, "renderer", "index.html"), "utf8");
  html = html.replace('href="style.css"', 'href="style.inline.css"');
  fs.writeFileSync(path.join(ROOT, "renderer", "index.inline.html"), html);
  console.log(
    "[prepare-build] inlined shared styles -> renderer/style.inline.css + index.inline.html",
  );
}
inlineSharedStyles();

// ── 内置 material-hub 外部二进制（yt-dlp.exe）──
// 素材搜集模块的宣传片下载强依赖 yt-dlp；用户机器不保证装过、更不保证在 PATH。
// 这里在打包前确保 material-hub/bin/yt-dlp.exe 就位，由 extraResources 一并进安装包。
// 下载失败必须让构建失败（exit 1），避免无声出一个「点运行必失败」的包。
// 注意：ffmpeg/ffprobe 走 npm 包（@ffmpeg-installer / @ffprobe-installer），
// 由 npm --prefix material-hub install 装进 node_modules，无需在此处理。
const prepareMaterialBins = require("./prepare-material-bins");

// ── 内置 biliup-hub 外部二进制（biliup.exe）──
// B 站投稿模块的每一次投稿都要 fork biliup.exe；此前只有 CI 会下载它，
// 本地构建因此会静默产出缺该 exe 的残包（装上后投稿必失败）。
// 串进同一条 Promise 链：两个二进制都就位才算 done，任一失败都 exit 1。
const prepareBiliupBin = require("./prepare-biliup-bin");

prepareMaterialBins
  .main()
  .then(() => {
    console.log("[prepare-build] material-hub 二进制就位");
    return prepareBiliupBin.main();
  })
  .then(() => {
    console.log("[prepare-build] biliup-hub 二进制就位");
    console.log("[prepare-build] done");
  })
  .catch((e) => {
    console.error(
      "[prepare-build] 外部二进制准备失败：" + (e && e.message ? e.message : String(e)),
    );
    process.exit(1);
  });
