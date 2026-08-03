#!/usr/bin/env node
/**
 * verify-build-assets.js — 打包产物资产校验（发布质量门禁）
 *
 * 根因背景（2026-07-30）：renderer/style.css 用 @import "../shared/tokens.css" 引入
 * 全部颜色变量与亮/暗主题规则，但 package.json 的 build.files 漏打包 shared/，
 * 装包后 @import 加载失败 -> 整窗全黑、且点主题按钮设了 data-theme=light 也无规则生效
 * （切不了主题）。dev 模式因项目目录有 shared/ 正常，装包才黑，多台机器一致。
 *
 * 根因背景（2026-08-04，extraResources 层）：material-hub（素材搜集）运行时强依赖三个
 * 外部二进制 —— yt-dlp.exe（下宣传片）、ffmpeg.exe / ffprobe.exe（抽帧与探测）。它们不在
 * app.asar 里，而是走 extraResources 落盘到 resources/material-hub/{bin,node_modules}/。
 * 事故形态：yt-dlp 下载步骤静默失效（GitHub 返回重定向/错误页，被当成 exe 存下来，只有几 KB）、
 * 或有人把 extraResources 的 filter 改成排掉 node_modules/**，构建照样「全部通过、产物可发布」，
 * 用户装完点「运行」必失败。本脚本原先只解包校验 app.asar，对这一层完全没有覆盖。
 * 因此新增 extraResources 层门禁：既校验产物里二进制真实存在且体积合理（>1MB，专治
 * 「把 HTML 错误页当 exe 打进去」），也在源码层校验 build.extraResources 的 filter
 * 没有把 bin/ 或 node_modules/ 整体排掉（未构建时也能拦住改坏配置的回归）。
 *
 * 根因背景（2026-08-04，npm 暂存残留层）：npm(@npmcli/arborist) 装包时先把 tar 解到
 * 同级的「点开头 + 随机后缀」暂存目录，落盘完再原子 rename 成正式目录，命名文法是
 * `.<包名去 scope>-<crypto.randomBytes(6).toString("base64url")>`（连字符后恰好 8 位）。
 * 装完 npm 会清掉；但安装一旦被打断（本机曾在写 package-lock.json 时被 EPERM 打断）就会残留。
 * 事故形态：material-hub/node_modules 里 @ffmpeg-installer/.win32-x64-XXXXXXXX/ffmpeg.exe(61.5MB)
 * 与 @ffprobe-installer/.win32-x64-XXXXXXXX/ffprobe.exe(77.2MB) 和正式目录**同时存在**，
 * 而 extraResources 的 filter 是 "**\/*" 全量纳入、没有任何规则排除点开头暂存目录，
 * 于是这 138.7MB 冗余重复二进制被原样打进安装包；另有一条 .tools-hub-XXXXXXXX 暂存**符号链接**
 * 指向开发机绝对路径，装到用户机上是悬空链接还泄露本地路径。校验全绿、功能正常，纯属白胖。
 * 对策是给四个子模块的 filter 都加两条规则（精准层 + 兜底层，见 test/extra-resources-filter.test.js
 * 里对 electron-builder minimatch 语义的实证），本脚本则在产物层兜底断言「一条残留都不许有」。
 *
 * 本脚本在构建后运行，断言产物(app.asar + extraResources)里确实包含关键资产，
 * 避免同类回归流入发布。asar 部分用官方 @electron/asar CLI 解包到临时目录再断言；
 * extraResources 部分直接读 dist/win-unpacked/resources/ 下的落盘文件。
 * 失败时以非零退出码中断构建/CI。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname.replace(/[\\/]scripts$/, "");
const failures = [];
const ok = [];

/** 外部二进制的体积下限：低于此值几乎必然是错误页/重定向 HTML 而非真 exe。 */
const MIN_BINARY_BYTES = 1024 * 1024;

/** extraResources 里绝不允许被整体排除的目录（排掉即等于运行时缺依赖）。 */
const PROTECTED_DIRS = ["bin", "node_modules"];

/** 走 extraResources 进包、因而需要防 npm 暂存残留的四个子模块。 */
const SUBMODULES = ["kdocs-tool", "netdisk-hub", "biliup-hub", "material-hub"];

/**
 * npm 暂存目录排除规则（必须与 package.json build.extraResources 各条 filter 完全一致）。
 * 两条分层：前者精准匹配 8 位随机后缀、能连条目本身（含符号链接）一起排掉；
 * 后者只排「点开头带连字符目录」的内容，作为 npm 改后缀长度时的兜底。
 * 二者都不会误伤 node_modules/.bin（无连字符）与 .package-lock.json（连字符后 9 字符、且是文件）。
 */
const NPM_STAGING_RULES = ["!node_modules/**/.*-????????", "!node_modules/**/.*-*/**"];

/** npm 暂存条目命名文法：点 + 任意 + 连字符 + 恰好 8 位 base64url 随机后缀。 */
const NPM_STAGING_NAME_RE = /^\.[^\\/]*-[A-Za-z0-9_-]{8}$/;

function fail(msg) {
  failures.push(msg);
}
function pass(msg) {
  ok.push(msg);
}

/* 定位 @electron/asar CLI 入口（优先 require.resolve，回退固定路径） */
function findAsarBin() {
  try {
    return require.resolve("@electron/asar/bin/asar.js");
  } catch (_) {
    const p = path.join(ROOT, "node_modules", "@electron", "asar", "bin", "asar.js");
    if (fs.existsSync(p)) return p;
    const alt = path.join(ROOT, "node_modules", ".bin", "asar");
    if (fs.existsSync(alt)) return alt;
    throw new Error("找不到 @electron/asar，请先 npm install");
  }
}

/* ---------- 纯函数区（可被单测直接 require，不碰文件系统） ---------- */

/**
 * 体积是否达标。之所以用「严格大于」而不是「不为 0」：GitHub 下载失败时返回的
 * 是几 KB 的 HTML 错误页，文件存在、大小非零，只有体积阈值能识别出来。
 * @param {number} bytes 实际字节数
 * @param {number} [min] 下限（默认 1MB）
 * @returns {boolean}
 */
function isSaneBinarySize(bytes, min = MIN_BINARY_BYTES) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return false;
  return bytes > min;
}

/**
 * 字节数转可读文案，仅用于失败提示（让人一眼看出「才 3.2KB，肯定是错误页」）。
 * @param {number} bytes 字节数
 * @returns {string}
 */
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "未知大小";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 判断单条 filter 规则是否会把某个目录「整体」排掉。
 *
 * 只有排除规则（! 开头）才可能造成整体丢失；`!node_modules/**\/.cache` 这类
 * 精确到子路径的规则是既有且必要的（剔缓存），不能误判成危险规则，
 * 所以这里只认「正好覆盖整个目录」的几种写法，而不是做前缀模糊匹配。
 * @param {string} rule 单条 filter 规则，如 "!node_modules/**"
 * @param {string} dirName 受保护目录名，如 "bin"
 * @returns {boolean} true 表示该规则会让整个目录消失
 */
function ruleBlocksDir(rule, dirName) {
  if (typeof rule !== "string" || typeof dirName !== "string" || !dirName) return false;
  const trimmed = rule.trim();
  if (!trimmed.startsWith("!")) return false;

  let body = trimmed.slice(1).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!body) return false;

  // 通配一切的排除规则（!**、!**\/*、!*）会连带干掉所有受保护目录
  if (body === "*" || body === "**" || body === "**/*") return true;

  // `**/dir/**` 与 `dir/**` 对顶层目录的效果一致，归一化后统一比较
  if (body.startsWith("**/")) body = body.slice(3);

  const wholeDirForms = [
    dirName,
    `${dirName}/`,
    `${dirName}/*`,
    `${dirName}/**`,
    `${dirName}/**/*`,
  ];
  return wholeDirForms.includes(body);
}

/**
 * 找出 filter 数组里所有会整体排掉受保护目录的规则。
 * @param {string[]} filter filter 数组
 * @param {string[]} [dirNames] 受保护目录名列表
 * @returns {Array<{rule: string, dir: string}>} 命中的危险规则（空数组表示安全）
 */
function findBlockingFilterRules(filter, dirNames = PROTECTED_DIRS) {
  if (!Array.isArray(filter)) return [];
  const hits = [];
  for (const rule of filter) {
    for (const dir of dirNames) {
      if (ruleBlocksDir(rule, dir)) hits.push({ rule: String(rule), dir });
    }
  }
  return hits;
}

/**
 * filter 是否含「全量纳入」的正向规则。
 *
 * 另一种改坏方式不是加排除，而是把 `**\/*` 换成 `lib/**\/*` 这类窄白名单，
 * 结果 bin/ 与 node_modules/ 悄无声息地不进包 —— 这种情况没有任何 ! 规则，
 * 只靠 findBlockingFilterRules 抓不到，所以单独判一次。
 * @param {string[]} filter filter 数组
 * @returns {boolean} 无 filter 或含全量正向规则时为 true
 */
function filterHasCatchAllInclude(filter) {
  if (!Array.isArray(filter) || filter.length === 0) return true; // 不写 filter = 全量拷贝
  const positives = filter
    .map((r) => (typeof r === "string" ? r.trim() : ""))
    .filter((r) => r && !r.startsWith("!"));
  if (positives.length === 0) return true; // 只有排除规则时，electron-builder 默认全量纳入
  return positives.some((r) => {
    const body = r.replace(/\\/g, "/").replace(/^\.\//, "");
    return body === "**/*" || body === "**" || body === "*";
  });
}

/**
 * 判断一个目录/文件名是否是 npm 安装暂存残留。
 *
 * 只认 npm 真实的命名文法（点 + 名字 + 连字符 + 恰好 8 位 base64url），不做「点开头就算」
 * 的模糊判断 —— 否则会把 .bin、.package-lock.json、.cache 这些正常条目一起冤枉了。
 * @param {string} name 目录或文件名（不含路径）
 * @returns {boolean} true 表示是 npm 暂存残留，应当排除
 */
function isNpmStagingName(name) {
  if (typeof name !== "string" || !name) return false;
  return NPM_STAGING_NAME_RE.test(name);
}

/**
 * 检查某条 filter 是否带齐了 npm 暂存排除规则。
 * @param {string[]} filter filter 数组
 * @returns {string[]} 缺失的规则（空数组表示齐全）
 */
function findMissingStagingRules(filter) {
  const list = Array.isArray(filter) ? filter.map((r) => String(r).trim()) : [];
  return NPM_STAGING_RULES.filter((rule) => !list.includes(rule));
}

/**
 * 递归找出目录下所有 npm 暂存残留条目。用 lstat 语义（readdirSync withFileTypes 即是），
 * 绝不跟随符号链接 —— 残留里就有一条指向仓库根的链接，跟进去会无限递归。
 * @param {string} dir 起始目录
 * @param {string} baseDir 用于算相对路径的基准目录
 * @param {number} [maxDepth] 最大递归深度
 * @returns {string[]} 命中的相对路径列表
 */
function findNpmStagingLeftovers(dir, baseDir, maxDepth = 6) {
  const hits = [];
  if (maxDepth < 0) return hits;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return hits;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (isNpmStagingName(ent.name)) {
      hits.push(path.relative(baseDir, full).replace(/\\/g, "/"));
      continue; // 已命中整条，无需再下钻
    }
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      hits.push(...findNpmStagingLeftovers(full, baseDir, maxDepth - 1));
    }
  }
  return hits;
}

/**
 * 推导产物路径。ASAR_PATH 与 RESOURCES_DIR 任设其一即可，两者互相推导，
 * 保证「只设一个」时二者仍指向同一个 resources/ 目录，不会一个看新产物一个看旧产物。
 * @param {object} [env] 环境变量对象
 * @param {string} [root] 仓库根目录
 * @returns {{asarPath: string, resourcesDir: string}}
 */
function resolveArtifactPaths(env = process.env, root = ROOT) {
  const defaultResources = path.join(root, "dist", "win-unpacked", "resources");
  const envAsar = env && env.ASAR_PATH ? path.resolve(env.ASAR_PATH) : "";
  const envRes = env && env.RESOURCES_DIR ? path.resolve(env.RESOURCES_DIR) : "";

  const asarPath =
    envAsar || (envRes ? path.join(envRes, "app.asar") : path.join(defaultResources, "app.asar"));
  const resourcesDir = envRes || (envAsar ? path.dirname(envAsar) : defaultResources);
  return { asarPath, resourcesDir };
}

/**
 * 在目录下递归查找指定文件名，返回第一个命中的绝对路径。
 *
 * 之所以递归找而不是写死 `@ffmpeg-installer/win32-x64/ffmpeg.exe`：平台子包的目录名
 * 由安装器按 os-arch 决定，升级后结构可能变；递归找对结构变化免疫。
 * 同时跳过点开头目录 —— npm 安装过程会遗留 `.win32-x64-XXXXXX/` 半成品目录，
 * 命中它会让校验通过但产物里其实没有可用文件。
 * @param {string} dir 起始目录
 * @param {string} fileName 目标文件名（大小写不敏感）
 * @param {number} [maxDepth] 最大递归深度，防目录环
 * @returns {string|null} 绝对路径，未找到返回 null
 */
function findFileRecursive(dir, fileName, maxDepth = 8) {
  if (maxDepth < 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const target = String(fileName).toLowerCase();
  const subDirs = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) subDirs.push(full);
    else if (ent.name.toLowerCase() === target) return full;
  }
  for (const sub of subDirs) {
    const hit = findFileRecursive(sub, fileName, maxDepth - 1);
    if (hit) return hit;
  }
  return null;
}

/* ---------- 1) 源码级防护：build.files 必须包含 shared 目录 ---------- */
function checkPackageFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const files = (pkg.build && pkg.build.files) || [];
  if (!files.some((f) => f === "shared/**/*" || f === "shared")) {
    fail(
      "package.json build.files 未包含 shared/**/* —— 子工具 /tokens.css 路由与 @import 源将缺失",
    );
  } else {
    pass("build.files 含 shared/**/*");
  }
}

/* ---------- 2) 源码级防护：extraResources 的 material-hub 条目不能排掉 bin/node_modules ---------- */
function checkExtraResourcesConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const entries = (pkg.build && pkg.build.extraResources) || [];
  const entry = entries.find((e) => e && typeof e === "object" && e.from === "material-hub");
  if (!entry) {
    fail(
      'package.json build.extraResources 缺少 from: "material-hub" 条目 —— ' +
        "素材模块本体、bin/yt-dlp.exe 与 node_modules 里的 ffmpeg/ffprobe 都不会进包",
    );
    return;
  }
  pass('build.extraResources 含 from: "material-hub" 条目');

  const filter = Array.isArray(entry.filter) ? entry.filter : [];
  const blocking = findBlockingFilterRules(filter, PROTECTED_DIRS);
  if (blocking.length) {
    for (const hit of blocking) {
      fail(
        `build.extraResources[material-hub].filter 含危险规则 "${hit.rule}" —— ` +
          `会整体排掉 ${hit.dir}/，导致运行时二进制缺失`,
      );
    }
  } else {
    pass("build.extraResources[material-hub].filter 未整体排除 bin/ 与 node_modules/");
  }

  if (!filterHasCatchAllInclude(filter)) {
    fail(
      "build.extraResources[material-hub].filter 的正向规则不是全量（缺 **/*）—— " +
        "bin/ 与 node_modules/ 可能被窄白名单漏掉",
    );
  } else {
    pass("build.extraResources[material-hub].filter 保留了全量纳入规则");
  }

  // 四个子模块都必须带齐 npm 暂存排除规则：**/* 是全量纳入，少一条就会把
  // 打断的 npm 安装留下的 .<name>-<8位> 暂存目录连同里面的重复二进制一起打进包。
  for (const name of SUBMODULES) {
    const sub = entries.find((e) => e && typeof e === "object" && e.from === name);
    if (!sub) continue; // 条目本身缺失由上面的 material-hub 断言与产物级校验负责
    const missing = findMissingStagingRules(sub.filter);
    if (missing.length) {
      fail(
        `build.extraResources[${name}].filter 缺少 npm 暂存排除规则 ${missing.join(" 与 ")} —— ` +
          "npm 安装被打断时残留的 .<包名>-<8位随机> 暂存目录会连重复二进制一起进包（曾白胖 138.7MB）",
      );
    } else {
      pass(`build.extraResources[${name}].filter 已排除 npm 暂存目录`);
    }
  }
}

/* ---------- 3) 产物级校验：解包 app.asar 后读文件 ---------- */
function checkAsar(asarPath) {
  if (!fs.existsSync(asarPath)) {
    fail(`未找到构建产物: ${asarPath}（请先执行 build/dist）`);
    return;
  }
  const asarBin = findAsarBin();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "toolshub-verify-"));
  try {
    execFileSync(process.execPath, [asarBin, "extract", asarPath, tmp], {
      stdio: "pipe",
    });
  } catch (e) {
    fail(`解包 asar 失败: ${(e.stderr || e.message || "").toString().split("\n")[0]}`);
    return;
  }

  const must = [
    ["shared/tokens.css", "shared 样式源（子工具 /tokens.css 路由依赖）"],
    ["renderer/style.inline.css", "内联后的入口样式"],
    ["renderer/index.inline.html", "实际加载的入口页"],
  ];
  for (const [rel, desc] of must) {
    const p = path.join(tmp, rel);
    if (fs.existsSync(p)) pass(`产物含 ${rel}（${desc}）`);
    else fail(`产物缺失 ${rel}（${desc}）`);
  }

  const cssPath = path.join(tmp, "renderer", "style.inline.css");
  if (fs.existsSync(cssPath)) {
    const css = fs.readFileSync(cssPath, "utf8");
    if (css.includes("--bg-1")) pass("style.inline.css 含主题变量 --bg-1");
    else fail("style.inline.css 未内联主题变量 --bg-1（@import 可能未展开）");

    if (css.includes('data-theme="light"'))
      pass('style.inline.css 含亮色主题规则 [data-theme="light"]');
    else fail('style.inline.css 缺失亮色主题规则 [data-theme="light"]（切不了主题）');

    // 仅匹配真实 @import at-rule（@import url(...) 或 @import "..."），忽略注释里的字眼
    if (/@import\s*(url\(|["'])/.test(css))
      fail("style.inline.css 仍含 @import（运行时依赖跨目录加载，脆弱）");
    else pass("style.inline.css 无 @import（已构建期内联，运行时零依赖）");
  }

  const htmlPath = path.join(tmp, "renderer", "index.inline.html");
  if (fs.existsSync(htmlPath)) {
    const html = fs.readFileSync(htmlPath, "utf8");
    if (html.includes("style.inline.css")) pass("index.inline.html 引用 style.inline.css");
    else fail("index.inline.html 未引用 style.inline.css（仍可能加载旧 style.css）");
  }
}

/* ---------- 4) 产物级校验：extraResources 落盘的模块本体与外部二进制 ---------- */

/** 断言普通文件存在（模块本体，不做体积要求）。 */
function assertResourceFile(resourcesDir, rel, desc) {
  const p = path.join(resourcesDir, rel);
  if (fs.existsSync(p)) pass(`extraResources 含 ${rel}（${desc}）`);
  else fail(`extraResources 缺失 ${rel}（${desc}）`);
}

/** 断言二进制存在且体积达标。 */
function assertResourceBinary(resourcesDir, rel, desc) {
  const p = path.join(resourcesDir, rel);
  if (!fs.existsSync(p)) {
    fail(`extraResources 缺失二进制 ${rel}（${desc}）—— 装包后点运行必失败`);
    return;
  }
  const size = fs.statSync(p).size;
  if (isSaneBinarySize(size)) {
    pass(`extraResources 含 ${rel}（${desc}，${formatBytes(size)}）`);
  } else {
    fail(
      `extraResources 的 ${rel} 体积异常（${formatBytes(size)} < 1MB，${desc}）—— ` +
        "疑似把下载错误页/重定向 HTML 当成 exe 打进了包",
    );
  }
}

/** 在 npm scope 目录下递归找平台二进制并断言体积（结构随安装器版本变，不写死路径）。 */
function assertScopedBinary(resourcesDir, scopeRel, exeName, desc) {
  const scopeDir = path.join(resourcesDir, scopeRel);
  if (!fs.existsSync(scopeDir)) {
    fail(`extraResources 缺失 ${scopeRel}/（${desc}）—— material-hub 依赖未安装或被 filter 排除`);
    return;
  }
  const hit = findFileRecursive(scopeDir, exeName);
  if (!hit) {
    fail(`在 ${scopeRel}/ 下未找到 ${exeName}（${desc}）—— 平台子包缺失或只装了非 win32-x64 版本`);
    return;
  }
  const rel = path.relative(resourcesDir, hit).replace(/\\/g, "/");
  const size = fs.statSync(hit).size;
  if (isSaneBinarySize(size)) {
    pass(`extraResources 含 ${rel}（${desc}，${formatBytes(size)}）`);
  } else {
    fail(
      `extraResources 的 ${rel} 体积异常（${formatBytes(size)} < 1MB，${desc}）—— 疑似安装不完整`,
    );
  }
}

function checkExtraResources(resourcesDir) {
  // 与 checkAsar 对缺失产物的处理保持同一语义：fail 并提示先构建，绝不静默跳过，
  // 否则「没构建也全绿」会让这道门禁形同虚设。
  if (!fs.existsSync(resourcesDir)) {
    fail(`未找到构建产物目录: ${resourcesDir}（请先执行 build/dist）`);
    return;
  }

  // 模块本体：确认四个子服务都真的落盘了（main.js 靠 fork 这些入口拉起子进程）
  assertResourceFile(resourcesDir, "material-hub/server.js", "素材搜集模块入口");
  assertResourceFile(resourcesDir, "material-hub/lib/env.js", "素材模块外部二进制定位器");
  // kdocs-tool 的真实入口链是 server.js -> index.js（router.js 是历史遗留、已不在 fork 路径上），
  // 两个都断言才能保证子进程真的拉得起来。
  assertResourceFile(resourcesDir, "kdocs-tool/server.js", "金山文档模块入口");
  assertResourceFile(resourcesDir, "kdocs-tool/index.js", "金山文档模块路由主体");
  assertResourceFile(resourcesDir, "netdisk-hub/server.js", "网盘模块入口");
  assertResourceFile(resourcesDir, "biliup-hub/server.js", "B站投稿模块入口");

  // 外部二进制：本次事故的正主，存在性 + 体积双重断言
  assertResourceBinary(resourcesDir, "material-hub/bin/yt-dlp.exe", "宣传片下载依赖");
  assertResourceBinary(resourcesDir, "biliup-hub/bin/biliup.exe", "B站投稿 CLI 依赖");

  assertScopedBinary(
    resourcesDir,
    "material-hub/node_modules/@ffmpeg-installer",
    "ffmpeg.exe",
    "视频抽帧依赖",
  );
  assertScopedBinary(
    resourcesDir,
    "material-hub/node_modules/@ffprobe-installer",
    "ffprobe.exe",
    "视频信息探测依赖",
  );

  // 产物层兜底：filter 写对了也可能哪天被人改回去，这里直接扫落盘结果。
  // 只要还有一条 npm 暂存残留进了包，就说明白白多背了几十上百 MB。
  let leftovers = [];
  for (const name of SUBMODULES) {
    const nm = path.join(resourcesDir, name, "node_modules");
    if (!fs.existsSync(nm)) continue;
    leftovers = leftovers.concat(findNpmStagingLeftovers(nm, resourcesDir));
  }
  if (leftovers.length) {
    const preview = leftovers.slice(0, 5).join("、");
    fail(
      `产物里残留 ${leftovers.length} 条 npm 暂存条目（${preview}${leftovers.length > 5 ? " 等" : ""}）—— ` +
        "extraResources 的暂存排除规则失效了，安装包会白白变大（历史上一次是 138.7MB）",
    );
  } else {
    pass("产物 node_modules 无 npm 暂存残留（无冗余重复二进制）");
  }
}

/* ---------- 入口 ---------- */
function main() {
  checkPackageFiles();
  checkExtraResourcesConfig();

  const { asarPath, resourcesDir } = resolveArtifactPaths(process.env, ROOT);
  checkAsar(asarPath);
  checkExtraResources(resourcesDir);

  console.log("\n=== 打包产物校验 ===");
  ok.forEach((m) => console.log("  ✓ " + m));
  if (failures.length) {
    console.log("\n✗ 校验失败：");
    failures.forEach((m) => console.log("  ✗ " + m));
    console.log(
      "\n构建被拦截。请确认 scripts/prepare-build.js 已生成 renderer/style.inline.css，" +
        "package.json build.files 含 shared/**/*，" +
        "且 `npm run prepare:material-bins` 与各子模块 npm install 均已执行" +
        "（yt-dlp.exe / biliup.exe / ffmpeg.exe / ffprobe.exe 需随包落盘）。\n",
    );
    process.exit(1);
  }
  console.log(`\n✓ 全部通过（${ok.length} 项），产物可发布。\n`);
}

// 直接执行才跑校验；被 require 时只暴露纯函数，便于单测。
if (require.main === module) main();

module.exports = {
  MIN_BINARY_BYTES,
  PROTECTED_DIRS,
  SUBMODULES,
  NPM_STAGING_RULES,
  isSaneBinarySize,
  formatBytes,
  ruleBlocksDir,
  findBlockingFilterRules,
  filterHasCatchAllInclude,
  isNpmStagingName,
  findMissingStagingRules,
  findNpmStagingLeftovers,
  resolveArtifactPaths,
  findFileRecursive,
  checkExtraResources,
  main,
};
