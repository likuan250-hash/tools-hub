// scripts/prepare-material-bins.js —— 内置 material-hub 所需的外部二进制（yt-dlp.exe）
//
// 背景：素材搜集模块的宣传片下载依赖 yt-dlp，用户机器上不一定装、也不一定在 PATH，
// 导致「点击运行一直不成功」。本脚本把 yt-dlp.exe 下载到 material-hub/bin/，
// 由根 package.json 的 build.extraResources（from: "material-hub"）一并打进安装包，
// 运行时 material-hub/lib/env.js 直接按 __dirname 定位，无需用户额外安装。
//
// ffmpeg / ffprobe 不在此处理：走 npm 包 @ffmpeg-installer/ffmpeg 与 @ffprobe-installer/ffprobe，
// 由 `npm --prefix material-hub install` 装进 material-hub/node_modules，同样被 extraResources 覆盖。
//
// 缺陷 2 修复：原实现直接用 https.get，而 Node 内置 https **不读** HTTP_PROXY/HTTPS_PROXY
// 环境变量。在直连 github.com 被墙的机器上（实测：直连 21s 超时 / 经代理 24.3s 拿到 18226085B），
// 这里会 100% 报「请求超时（120s）」。现在统一复用 material-hub/lib/http.js 的代理感知实现：
// 自动读取代理环境变量、尊重 NO_PROXY、HTTPS 走 CONNECT 隧道、跟随 GitHub 的两跳重定向。
//
// 幂等：已存在且体积 > 1MB 直接跳过；失败 process.exit(1)，避免无声出一个缺二进制的包。
const fs = require('fs');
const path = require('path');
const httpUtil = require('../material-hub/lib/http');

/** yt-dlp 官方 latest 直链（302 跳转到 release-assets.githubusercontent.com，需跟随重定向）。 */
const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
/** 目标目录：material-hub/bin（已在 material-hub/.gitignore 中忽略，不进 git）。 */
const BIN_DIR = path.resolve(__dirname, '..', 'material-hub', 'bin');
/** 目标文件。 */
const YT_DLP_DEST = path.join(BIN_DIR, 'yt-dlp.exe');
/** 认为「已就位」的最小体积（yt-dlp.exe 约 17MB，1MB 足以排除半截文件/占位文件）。 */
const MIN_VALID_BYTES = 1024 * 1024;
/** 最大重定向跳数，防环。 */
const MAX_REDIRECTS = 8;
/** 单次请求超时（经代理下 18MB 实测约 25s，120s 留足余量）。 */
const REQUEST_TIMEOUT = 120 * 1000;
/** 下载用 UA：GitHub 对无 UA 请求可能直接拒绝。 */
const USER_AGENT = 'tools-hub-prepare-material-bins';

/**
 * 判断本地文件是否已是可用的二进制（存在且体积达标）。
 * @param {string} file 文件绝对路径
 * @returns {number} 已就位时返回字节数；否则返回 0
 */
function existingSize(file) {
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size > MIN_VALID_BYTES) return st.size;
  } catch (e) {
    /* 不存在即视为未就位 */
  }
  return 0;
}

/**
 * 字节数转可读文本。
 * @param {number} bytes 字节数
 * @returns {string} 如 '17.2MB'
 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'KB';
  return n + 'B';
}

/**
 * 下载单个文件到本地（代理感知 + 自动跟随 3xx 重定向 + 进度打点到 stdout）。
 * @param {string} url 下载地址
 * @param {string} dest 目标文件绝对路径
 * @returns {Promise<number>} 落盘字节数
 */
async function download(url, dest) {
  let lastTick = 0;
  const r = await httpUtil.downloadToFile(url, dest, {
    timeout: REQUEST_TIMEOUT,
    maxRedirects: MAX_REDIRECTS,
    userAgent: USER_AGENT,
    minBytes: MIN_VALID_BYTES,
    headers: { Accept: 'application/octet-stream' },
    onRedirect: (status, next) => {
      console.log('[prepare-material-bins] 重定向 ' + status + ' -> ' + String(next).split('?')[0]);
    },
    onProgress: (received, total) => {
      const pct = total ? Math.floor((received / total) * 100) : 0;
      // 每 10% 打一次，避免刷屏
      if (total && pct >= lastTick + 10) {
        lastTick = pct - (pct % 10);
        console.log(
          '[prepare-material-bins] 下载中 ' + pct + '% (' + humanSize(received) + '/' + humanSize(total) + ')',
        );
      }
    },
  });
  return r.bytes;
}

/**
 * 主流程：确保 material-hub/bin/yt-dlp.exe 就位。
 * @returns {Promise<void>}
 */
async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const already = existingSize(YT_DLP_DEST);
  if (already) {
    console.log('[prepare-material-bins] yt-dlp.exe 已就位（' + humanSize(already) + '），跳过下载');
    console.log('[prepare-material-bins] 路径: ' + YT_DLP_DEST);
    return;
  }

  // 明确打印走没走代理，便于排查「一直超时」类问题
  console.log('[prepare-material-bins] 网络通道: ' + httpUtil.describeProxy(YT_DLP_URL));
  console.log('[prepare-material-bins] 下载 yt-dlp.exe <- ' + YT_DLP_URL);
  const bytes = await download(YT_DLP_URL, YT_DLP_DEST);
  console.log('[prepare-material-bins] yt-dlp.exe 已就位（' + humanSize(bytes) + '）');
  console.log('[prepare-material-bins] 路径: ' + YT_DLP_DEST);
}

// 作为脚本直接运行时执行；被 require 时（prepare-build.js 串联）由调用方决定时机。
if (require.main === module) {
  main()
    .then(() => {
      console.log('[prepare-material-bins] done');
    })
    .catch((e) => {
      console.error('[prepare-material-bins] 失败：' + (e && e.message ? e.message : String(e)));
      console.error('[prepare-material-bins] 若为网络问题，请确认 HTTP_PROXY / HTTPS_PROXY 环境变量已正确设置');
      console.error('[prepare-material-bins] 手动补救：下载 ' + YT_DLP_URL + ' 另存为 ' + YT_DLP_DEST);
      process.exit(1);
    });
}

module.exports = { main, download, existingSize, humanSize, YT_DLP_URL, YT_DLP_DEST, BIN_DIR, MIN_VALID_BYTES };
