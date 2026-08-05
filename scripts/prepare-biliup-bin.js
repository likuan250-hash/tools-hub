// scripts/prepare-biliup-bin.js —— 内置 biliup-hub 所需的外部二进制（biliup.exe）
//
// 根因背景：B 站投稿模块（biliup-hub）的所有投稿动作都靠外部 CLI `biliup.exe` 执行，
// 该 exe 通过 electron-builder 的 extraResources（from: "biliup-hub"）随包落盘到
// resources/biliup-hub/bin/biliup.exe。但此前**只有 CI**（.github/workflows/build.yml
// 的 "Download & bundle biliup.exe" pwsh 步骤）会去下载它，本地没有任何获取途径：
// 于是本地 `npm run dist` 会静默产出一个缺 biliup.exe 的残包，装上后投稿功能必失败。
// scripts/verify-build-assets.js 现在能把这个残包拦下来（报「extraResources 缺失二进制
// biliup-hub/bin/biliup.exe」），但拦下之后用户无路可走 —— 本脚本就是补上那条路，
// 让本地构建与 CI 构建产出的包完全等价。
//
// 为什么复用 material-hub/lib/http.js 而不是自己写 https 请求：
// Node 内置的 http/https **不读** HTTP_PROXY / HTTPS_PROXY 环境变量。在直连 github.com
// 被墙的机器上（本项目开发机即是，代理为 http://127.0.0.1:7990），任何裸 https.get 都会
// ETIMEDOUT。lib/http.js 已经实现了代理环境变量识别、NO_PROXY 绕行、HTTPS 经 HTTP 代理的
// CONNECT 隧道、以及 GitHub release 的多跳 30x 重定向跟随，直接复用即可，绝不重造。
//
// 为什么解压要 shell 出去调 PowerShell：Node 没有内置解压能力，而本项目是 Windows-only
// 构建（build.win.target = nsis/x64），系统必然自带 Expand-Archive。为此引入一个 zip 库
// 得不偿失，CI 的 pwsh 步骤走的也正是 Expand-Archive，两边逻辑因此保持同构。
//
// 幂等：目标 exe 已存在且体积 > 1MB 直接跳过；任何失败都 process.exit(1)，
// 避免无声出一个「点投稿必失败」的包。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const httpUtil = require('../material-hub/lib/http');

/**
 * 固定版本：与代码注释里实测的 CLI 语法（v0.2.4）严格对齐，禁止漂移到 latest——
 * 上游升级 CLI 参数可能变化，用 latest 会「构建时无感换语法、装包后投稿必失败」。
 * 升级 biliup-rs 时需同步：改 BILIUP_VERSION + 重算 BILIUP_SHA256（对 Windows zip）。
 */
const BILIUP_VERSION = 'v0.2.4';
/** biliupR-${BILIUP_VERSION}-x86_64-windows.zip 的 SHA256（2026-08-05 实测）。 */
const BILIUP_SHA256 = 'bdd3d7a56f00aea580cd3e609fd4b1748085e68ea2f1527d4aa8ff06b9796365';
/** 固定版本 release 元数据接口（不再用 /latest）。 */
const RELEASE_API = 'https://api.github.com/repos/biliup/biliup-rs/releases/tags/' + BILIUP_VERSION;
/** 目标目录：biliup-hub/bin（真实二进制不进 git，由本脚本 / CI 现拉）。 */
const BIN_DIR = path.resolve(__dirname, '..', 'biliup-hub', 'bin');
/** 目标文件：运行时与打包后路径均按 biliup-hub/bin/biliup.exe 定位。 */
const BILIUP_DEST = path.join(BIN_DIR, 'biliup.exe');
/** 解压临时目录的父目录（biliup-hub/.gitignore 已忽略 .tmp/，且 extraResources 已用 !.tmp/** 排除）。 */
const TMP_ROOT = path.resolve(__dirname, '..', 'biliup-hub', '.tmp');
/** 临时工作目录名前缀：用固定前缀才能在下次运行时认出并扫掉上次的残留。 */
const TMP_PREFIX = 'biliup-bin-';
/** 认为「已就位」的最小体积（biliup.exe 约十几 MB，1MB 足以排除半截文件/错误页）。 */
const MIN_VALID_BYTES = 1024 * 1024;
/** 最大重定向跳数，防环（GitHub 资产会跳到 objects.githubusercontent.com）。 */
const MAX_REDIRECTS = 8;
/** 单次请求超时（经代理下十几 MB 实测数十秒，180s 留足余量）。 */
const REQUEST_TIMEOUT = 180 * 1000;
/** UA：GitHub API 对无 UA 的请求直接返回 403。 */
const USER_AGENT = 'tools-hub-prepare-biliup-bin';
/** 读取 GitHub Token 的环境变量优先级（CI 用 GH_TOKEN，本地两个都认）。 */
const TOKEN_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN'];
/** PowerShell 宿主候选：优先 pwsh（CI 用它），回退 Windows 自带的 powershell。 */
const POWERSHELL_CANDIDATES = ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'];

/* ---------- 纯函数区（单测主战场，全部不碰网络、不碰解压） ---------- */

/**
 * 字节数转可读文本。
 * @param {number} bytes 字节数
 * @returns {string} 如 '15.3MB'
 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

/**
 * 判定「本地文件已足够好，可以跳过下载」。
 *
 * 之所以用体积阈值而不是「文件存在即跳过」：下载中断留下的半截文件、以及被当成 exe
 * 存下来的 GitHub 错误页都只有几 KB，存在性判断会让这些垃圾一路混进安装包。
 * @param {number} size 本地文件字节数（不存在时传 0）
 * @param {number} [min] 体积下限，默认 1MB
 * @returns {boolean} true = 跳过下载
 */
function shouldSkipDownload(size, min = MIN_VALID_BYTES) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return false;
  const floor = typeof min === 'number' && Number.isFinite(min) && min >= 0 ? min : MIN_VALID_BYTES;
  return size > floor;
}

/** 计算文件 SHA256（小写 hex）。 */
function sha256Of(file, fsImpl) {
  const f = fsImpl || fs;
  return crypto.createHash('sha256').update(f.readFileSync(file)).digest('hex').toLowerCase();
}

/**
 * 校验文件 SHA256 与期望值一致；不一致抛错（调用方应让构建失败）。
 * @param {string} file 文件绝对路径
 * @param {string} expected 期望的小写/大写 hex 均可
 * @param {object} [fsImpl] 单测注入
 * @returns {boolean} 一致返回 true
 */
function verifySha256(file, expected, fsImpl) {
  const actual = sha256Of(file, fsImpl);
  if (String(expected || '').toLowerCase() !== actual) {
    throw new Error(
      'SHA256 校验失败: ' + path.basename(file) +
      ' 实际=' + actual + ' 期望=' + expected +
      '。若升级了 biliup-rs 版本，请同步更新 BILIUP_SHA256 常量。'
    );
  }
  return true;
}

/**
 * 资产名是否是 zip 包（决定走「解压取 exe」还是「直接落盘改名」两条分支）。
 * @param {string} name 资产文件名
 * @returns {boolean}
 */
function isZipName(name) {
  return /\.zip$/i.test(String(name == null ? '' : name).trim());
}

/**
 * 从 release 的 assets 数组里挑出 Windows x64 那个。
 *
 * 匹配顺序完全沿用 build.yml 第 111-113 行，保证本地与 CI 选到同一个资产：
 *   ① 名字含 x86_64-windows 或 windows-x64（biliup-rs 的正式命名，如 biliupR-v0.2.7-x86_64-windows.zip）
 *   ② 退而求其次：含 windows 的 .zip
 *   ③ 再退一步：任意 .exe
 * 三轮都没命中就返回 null，由调用方明确报错 —— 绝不静默挑一个不知道是什么的资产。
 * @param {Array<{name?: string, browser_download_url?: string}>} assets release.assets
 * @returns {object|null} 命中的资产对象；未命中返回 null
 */
function pickWindowsAsset(assets) {
  const list = Array.isArray(assets)
    ? assets.filter((a) => a && typeof a === 'object' && typeof a.name === 'string' && a.name.trim())
    : [];
  if (!list.length) return null;

  const rounds = [
    (n) => /x86_64-windows/i.test(n) || /windows-x64/i.test(n),
    (n) => /\.zip$/i.test(n) && /windows/i.test(n),
    (n) => /\.exe$/i.test(n),
  ];
  for (const match of rounds) {
    const hit = list.find((a) => match(a.name));
    if (hit) return hit;
  }
  return null;
}

/**
 * 按环境变量组装 GitHub API 的认证头。
 *
 * 匿名调 GitHub API 每小时只有 60 次配额（按出口 IP 计），本机走代理时这 60 次
 * 还要和代理后面所有人共享，非常容易撞满。带上 token 后配额是 5000/小时。
 * @param {object} [env=process.env] 环境变量来源（单测注入）
 * @returns {{Authorization?: string}} 有 token 时返回带 Authorization 的头，否则空对象
 */
function resolveTokenHeaders(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  for (const key of TOKEN_ENV_KEYS) {
    const raw = src[key];
    if (typeof raw === 'string' && raw.trim()) {
      return { Authorization: 'Bearer ' + raw.trim() };
    }
  }
  return {};
}

/**
 * 把 GitHub API 的失败响应翻译成人话。
 *
 * 直接抛「HTTP 403」会让人完全摸不着头脑（明明浏览器能打开这个接口）。403 的绝大多数
 * 成因是匿名配额耗尽，必须把「配额用完了」「什么时候恢复」「配 GH_TOKEN 可解」三件事说清楚。
 * @param {number} status HTTP 状态码
 * @param {object} [headers] 响应头（用于读 x-ratelimit-*）
 * @param {object} [body] 已解析的响应体
 * @param {boolean} [hasToken] 本次请求是否已带 token
 * @returns {string} 空串表示这不是失败响应；否则为可直接展示给人的错误文案
 */
function describeApiFailure(status, headers, body, hasToken) {
  const code = Number(status) || 0;
  if (code >= 200 && code < 300) return '';

  const h = headers && typeof headers === 'object' ? headers : {};
  const b = body && typeof body === 'object' ? body : {};
  const apiMessage = typeof b.message === 'string' ? b.message : '';
  const remaining = h['x-ratelimit-remaining'];
  const reset = Number(h['x-ratelimit-reset']) || 0;
  const rateLimited =
    (code === 403 || code === 429) &&
    (String(remaining) === '0' || /rate limit|api rate/i.test(apiMessage));

  if (rateLimited) {
    const when = reset ? new Date(reset * 1000).toLocaleString('zh-CN') : '未知时间';
    const tokenHint = hasToken
      ? '当前已带 token 仍被限流，说明该 token 的 5000 次/小时配额也用尽了，请稍后再试。'
      : '当前为匿名请求（60 次/小时，按出口 IP 计，走代理时与他人共享）。' +
        '设置环境变量 GH_TOKEN 或 GITHUB_TOKEN 为任意 GitHub Personal Access Token 后重试，配额将提升到 5000 次/小时。';
    return (
      'GitHub API 触发速率限制（HTTP ' + code + '）。配额将于 ' + when + ' 恢复。' + tokenHint
    );
  }
  if (code === 401) {
    return 'GitHub API 拒绝认证（HTTP 401）：GH_TOKEN / GITHUB_TOKEN 无效或已过期，请更换或清空该环境变量后重试。';
  }
  if (code === 404) {
    return 'GitHub API 返回 404：biliup/biliup-rs 仓库或其 latest release 不存在（上游可能改名/删除了 release）。';
  }
  return 'GitHub API 请求失败（HTTP ' + code + '）' + (apiMessage ? '：' + apiMessage : '');
}

/**
 * 挑出「解压产物里应当作为 biliup.exe 落盘」的那个文件。
 *
 * 与 build.yml 第 122-124 行同构：先精确找 biliup.exe，找不到退而求其次取任意 .exe
 * （上游曾出现过 biliupR.exe 这类命名），仍找不到返回 null 由调用方报错。
 * @param {string[]} files 解压出的文件路径列表
 * @returns {string|null} 命中的路径；未命中返回 null
 */
function pickExtractedExe(files) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f) : [];
  const exact = list.find((f) => path.basename(f).toLowerCase() === 'biliup.exe');
  if (exact) return exact;
  const anyExe = list.find((f) => /\.exe$/i.test(f));
  return anyExe || null;
}

/* ---------- 带 IO 的实现 ---------- */

/**
 * 读取本地文件体积（不存在/不是文件时返回 0）。
 * @param {string} file 文件绝对路径
 * @returns {number} 字节数
 */
function existingSize(file) {
  try {
    const st = fs.statSync(file);
    if (st.isFile()) return st.size;
  } catch (e) {
    /* 不存在即视为未就位 */
  }
  return 0;
}

/**
 * 递归列出目录下所有文件的绝对路径。
 * @param {string} dir 起始目录
 * @param {number} [maxDepth=8] 最大递归深度，防目录环
 * @returns {string[]} 文件绝对路径列表
 */
function listFilesRecursive(dir, maxDepth = 8) {
  if (maxDepth < 0) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFilesRecursive(full, maxDepth - 1));
    else out.push(full);
  }
  return out;
}

/**
 * 清掉上一次运行遗留的临时目录。
 *
 * 为什么需要：Windows 上 rmSync 并非总能成功（杀软/资源管理器可能正抓着刚解压出来的 exe
 * 不放），失败时我们只警告不中断构建 —— 但如果不在下次开跑时补扫一遍，
 * biliup-hub/.tmp/ 就会随着每次构建越堆越多（每次约 15MB）。
 * @param {string} root 临时目录父目录
 * @param {string} prefix 本脚本使用的目录名前缀
 * @returns {number} 清理掉的目录数
 */
function sweepStaleTmp(root, prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  let removed = 0;
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(root, ent.name), { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      /* 仍被占用就留到下次，绝不因为清不掉垃圾而让构建失败 */
    }
  }
  return removed;
}

/**
 * 找一个可用的 PowerShell 宿主。
 * @returns {string} 可执行名；都不可用时返回空串
 */
function resolvePowerShell() {
  for (const exe of POWERSHELL_CANDIDATES) {
    try {
      execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: 'ignore',
        timeout: 30 * 1000,
        windowsHide: true,
      });
      return exe;
    } catch (e) {
      /* 该宿主不存在或不可用，试下一个 */
    }
  }
  return '';
}

/**
 * 用 PowerShell 的 Expand-Archive 解压 zip。
 *
 * 注意 zip 路径必须以 .zip 结尾：Expand-Archive 会按扩展名做合法性校验，
 * 传一个无扩展名的临时文件（CI 里那个 `biliup-download`）在部分 PS 版本上会被拒。
 * 所以下载时就按 .zip 命名，不给自己埋坑。
 * @param {string} zipPath zip 文件绝对路径
 * @param {string} destDir 解压目标目录
 * @returns {void}
 */
function expandArchive(zipPath, destDir) {
  const psExe = resolvePowerShell();
  if (!psExe) {
    throw new Error('未找到可用的 PowerShell（pwsh / powershell），无法解压 zip 资产');
  }
  // PowerShell 单引号字符串里转义单引号的方式是写两个单引号
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const command =
    "$ErrorActionPreference='Stop'; Expand-Archive -Force -LiteralPath " +
    q(zipPath) +
    ' -DestinationPath ' +
    q(destDir);
  try {
    execFileSync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : '';
    throw new Error(
      '解压失败（' + psExe + ' Expand-Archive）：' +
        (stderr || (e && e.message ? e.message : String(e))),
    );
  }
}

/**
 * 查询 biliup-rs 最新 release 元数据。
 * @param {object} [env=process.env] 环境变量来源
 * @returns {Promise<object>} release JSON
 */
async function fetchLatestRelease(env) {
  const source = env && typeof env === 'object' ? env : process.env;
  const auth = resolveTokenHeaders(source);
  const hasToken = Boolean(auth.Authorization);
  console.log(
    '[prepare-biliup-bin] GitHub API 认证: ' + (hasToken ? '已带 token（配额 5000/h）' : '匿名（配额 60/h）'),
  );

  const r = await httpUtil.fetchJson(RELEASE_API, {
    timeout: REQUEST_TIMEOUT,
    maxRedirects: MAX_REDIRECTS,
    userAgent: USER_AGENT,
    env: source,
    headers: Object.assign({ Accept: 'application/vnd.github+json' }, auth),
  });
  const problem = describeApiFailure(r.status, r.headers, r.json, hasToken);
  if (problem) throw new Error(problem);
  if (!r.json || !Array.isArray(r.json.assets)) {
    throw new Error('GitHub API 返回的 release 数据里没有 assets 数组，格式与预期不符');
  }
  return r.json;
}

/**
 * 下载单个资产到指定路径（代理感知 + 跟随重定向 + 进度打点）。
 *
 * 这里**故意不带** Authorization：browser_download_url 会 302 到
 * objects.githubusercontent.com 的预签名地址，那边已经用 query 参数鉴权，
 * 再叠一个 Authorization 头反而可能被判成「多重鉴权」而拒绝。公开仓库资产无需 token。
 * @param {string} url 下载地址
 * @param {string} dest 目标文件绝对路径
 * @param {object} [env=process.env] 环境变量来源
 * @returns {Promise<number>} 落盘字节数
 */
async function downloadAsset(url, dest, env) {
  let lastTick = 0;
  const r = await httpUtil.downloadToFile(url, dest, {
    timeout: REQUEST_TIMEOUT,
    maxRedirects: MAX_REDIRECTS,
    userAgent: USER_AGENT,
    minBytes: MIN_VALID_BYTES,
    env: env && typeof env === 'object' ? env : process.env,
    headers: { Accept: 'application/octet-stream' },
    onRedirect: (status, next) => {
      console.log('[prepare-biliup-bin] 重定向 ' + status + ' -> ' + String(next).split('?')[0]);
    },
    onProgress: (received, total) => {
      const pct = total ? Math.floor((received / total) * 100) : 0;
      // 每 10% 打一次，避免刷屏
      if (total && pct >= lastTick + 10) {
        lastTick = pct - (pct % 10);
        console.log(
          '[prepare-biliup-bin] 下载中 ' + pct + '% (' + humanSize(received) + '/' + humanSize(total) + ')',
        );
      }
    },
  });
  return r.bytes;
}

/**
 * 主流程：确保 biliup-hub/bin/biliup.exe 就位。
 * @returns {Promise<void>}
 */
async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // 先扫残留再判跳过：否则一旦 exe 已就位，后续每次构建都从跳过分支直接返回，
  // 上一次没删掉的临时目录就永远留在 .tmp/ 里没人收拾。
  const swept = sweepStaleTmp(TMP_ROOT, TMP_PREFIX);
  if (swept) console.log('[prepare-biliup-bin] 清理上次遗留的临时目录 ' + swept + ' 个');

  const already = existingSize(BILIUP_DEST);
  if (shouldSkipDownload(already)) {
    console.log('[prepare-biliup-bin] biliup.exe 已就位（' + humanSize(already) + '），跳过下载');
    console.log('[prepare-biliup-bin] 路径: ' + BILIUP_DEST);
    return;
  }
  if (already > 0) {
    console.log(
      '[prepare-biliup-bin] 发现残留文件（仅 ' + humanSize(already) + '，低于 1MB 下限），判定为半截下载/错误页，重新下载',
    );
  }

  // 明确打印走没走代理，便于排查「一直超时」类问题
  console.log('[prepare-biliup-bin] 网络通道: ' + httpUtil.describeProxy(RELEASE_API));
  console.log('[prepare-biliup-bin] 查询固定版本 release: ' + RELEASE_API);
  const release = await fetchLatestRelease(process.env);
  console.log('[prepare-biliup-bin] 版本: ' + (release.tag_name || release.name || BILIUP_VERSION));

  const asset = pickWindowsAsset(release.assets);
  if (!asset) {
    const names = (release.assets || []).map((a) => (a && a.name) || '?').join(', ');
    throw new Error(
      '未找到 biliup 的 Windows x64 资产（匹配规则：x86_64-windows / windows-x64 / windows*.zip / *.exe）。' +
        '当前 release 资产列表：' + (names || '(空)') + '。上游可能改了资产命名，请同步更新匹配规则。',
    );
  }
  const assetUrl = String(asset.browser_download_url || '');
  if (!assetUrl) throw new Error('资产 ' + asset.name + ' 缺少 browser_download_url 字段');
  console.log('[prepare-biliup-bin] 选定资产: ' + asset.name);

  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(TMP_ROOT, TMP_PREFIX));
  try {
    const isZip = isZipName(asset.name);
    // 统一给下载文件加 .zip 后缀：Expand-Archive 按扩展名校验合法性，无扩展名会被拒
    const downloadPath = path.join(workDir, isZip ? 'asset.zip' : 'asset.exe');
    console.log('[prepare-biliup-bin] 下载 <- ' + assetUrl);
    const startedAt = Date.now();
    const bytes = await downloadAsset(assetUrl, downloadPath, process.env);
    console.log(
      '[prepare-biliup-bin] 下载完成 ' + humanSize(bytes) + '，耗时 ' +
        ((Date.now() - startedAt) / 1000).toFixed(1) + 's',
    );

    // 下载物完整性校验：与固定版本 zip 的 SHA256 比对，防止上游资产被替换/下载被篡改。
    // 注意：browser_download_url 的预签名地址不区分文件版本，必须靠校验和兜底。
    console.log('[prepare-biliup-bin] 校验 SHA256（固定版本 ' + BILIUP_VERSION + '）...');
    verifySha256(downloadPath, BILIUP_SHA256, fs);
    console.log('[prepare-biliup-bin] SHA256 校验通过');

    if (isZip) {
      const extractDir = path.join(workDir, 'unzip');
      fs.mkdirSync(extractDir, { recursive: true });
      console.log('[prepare-biliup-bin] 解压中...');
      expandArchive(downloadPath, extractDir);
      const exe = pickExtractedExe(listFilesRecursive(extractDir));
      if (!exe) {
        throw new Error(
          '解压后未找到 biliup.exe，也没有任何 .exe 文件（资产 ' + asset.name + ' 结构与预期不符）',
        );
      }
      console.log('[prepare-biliup-bin] 解压产物: ' + path.relative(extractDir, exe));
      fs.copyFileSync(exe, BILIUP_DEST);
    } else {
      // 资产本身就是裸 exe：直接落盘改名（CI 的 else 分支同款）
      fs.copyFileSync(downloadPath, BILIUP_DEST);
    }
  } finally {
    // 无论成败都清掉临时目录，避免 .tmp/ 里堆下载残骸（fs.rmSync 不受外部 rm 包装器影响）
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (e) {
      // 清不掉只是留了点垃圾，绝不能因此让构建失败；但要把原因打出来（常见成因是
      // 杀软/资源管理器正抓着刚解压的 exe），否则下次有人看到 .tmp/ 堆积会一头雾水。
      console.warn(
        '[prepare-biliup-bin] 临时目录清理失败（不影响构建，下次运行会自动补扫）: ' +
          workDir + ' —— ' + (e && e.message ? e.message : String(e)),
      );
    }
  }

  const finalSize = existingSize(BILIUP_DEST);
  if (!shouldSkipDownload(finalSize)) {
    throw new Error(
      'biliup.exe 落盘后体积异常（' + humanSize(finalSize) + ' < 1MB），疑似取到了错误的文件',
    );
  }
  console.log('[prepare-biliup-bin] biliup.exe 已就位（' + humanSize(finalSize) + '）');
  console.log('[prepare-biliup-bin] 路径: ' + BILIUP_DEST);
}

// 作为脚本直接运行时执行；被 require 时（prepare-build.js 串联）由调用方决定时机。
if (require.main === module) {
  main()
    .then(() => {
      console.log('[prepare-biliup-bin] done');
    })
    .catch((e) => {
      console.error('[prepare-biliup-bin] 失败：' + (e && e.message ? e.message : String(e)));
      console.error('[prepare-biliup-bin] 若为网络问题，请确认 HTTP_PROXY / HTTPS_PROXY 环境变量已正确设置');
      console.error(
        '[prepare-biliup-bin] 手动补救：从 https://github.com/biliup/biliup-rs/releases/tag/' + BILIUP_VERSION + ' ' +
          '下载 Windows x64 包，解出 biliup.exe 放到 ' + BILIUP_DEST,
      );
      process.exit(1);
    });
}

module.exports = {
  // 纯函数（单测主战场）
  humanSize,
  shouldSkipDownload,
  sha256Of,
  verifySha256,
  isZipName,
  pickWindowsAsset,
  resolveTokenHeaders,
  describeApiFailure,
  pickExtractedExe,
  // 带 IO
  existingSize,
  listFilesRecursive,
  sweepStaleTmp,
  resolvePowerShell,
  expandArchive,
  fetchLatestRelease,
  downloadAsset,
  main,
  // 常量
  BILIUP_VERSION,
  BILIUP_SHA256,
  RELEASE_API,
  BIN_DIR,
  BILIUP_DEST,
  TMP_ROOT,
  TMP_PREFIX,
  MIN_VALID_BYTES,
  TOKEN_ENV_KEYS,
};
