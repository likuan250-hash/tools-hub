// lib/env.js —— 外部二进制定位（yt-dlp / ffmpeg / ffprobe）
//
// Bug B 根因之一：原实现只探测系统 PATH，用户机器没装 yt-dlp → 宣传片下载 100% 失败。
// 现在全部工具内置进项目，解析优先级（从高到低）：
//   ① 环境变量覆盖  MATERIAL_YT_DLP_BIN / MATERIAL_FFMPEG_BIN / MATERIAL_FFPROBE_BIN（便于测试注入）
//   ② 项目内置      material-hub/bin/yt-dlp.exe（prepare-material-bins.js 下载）
//                   @ffmpeg-installer/ffmpeg / @ffprobe-installer/ffprobe（npm 依赖，返回绝对路径）
//   ③ 系统 PATH     兜底（开发机上手工装过的情况）
//
// 打包态说明：main.js 里 CHILDREN.material 的 cwd/script 都是 resources/material-hub，
// 所以本文件 __dirname 在开发态与打包态都等于 material-hub/lib → '..' 即 material-hub 目录，
// bin/ 与 node_modules/ 均被 extraResources 带上，无需主进程注入环境变量。
const fsDefault = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** material-hub 根目录（本文件位于 material-hub/lib/）。 */
const HUB_DIR = path.resolve(__dirname, '..');
/** 内置二进制目录。 */
const BIN_DIR = path.join(HUB_DIR, 'bin');

/** 环境变量覆盖名（测试注入 / 高级用户自定义）。 */
const ENV_YT_DLP = 'MATERIAL_YT_DLP_BIN';
const ENV_FFMPEG = 'MATERIAL_FFMPEG_BIN';
const ENV_FFPROBE = 'MATERIAL_FFPROBE_BIN';

/** 缺失时的引导文案（工具已内置，缺失基本只可能是打包/下载环节出问题）。 */
const YT_DLP_GUIDANCE =
  '内置 yt-dlp 缺失：请在项目根执行 `npm run prepare:material-bins` 重新下载 material-hub/bin/yt-dlp.exe';
const FFMPEG_GUIDANCE =
  '内置 ffmpeg 缺失：请执行 `npm --prefix material-hub install` 安装 @ffmpeg-installer/ffmpeg';
const FFPROBE_GUIDANCE =
  '内置 ffprobe 缺失：请执行 `npm --prefix material-hub install` 安装 @ffprobe-installer/ffprobe';

/**
 * 默认的 PATH 探测实现：Windows 用 `where`，其余平台用 `which`。
 * 单测经构造函数注入替身，绝不真实 spawn。
 * @param {string} cmd 待探测的命令名，如 'yt-dlp'
 * @returns {string|null} 命中的绝对路径；未命中返回 null
 */
function defaultSpawnWhich(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(probe, [cmd], { windowsHide: true, encoding: 'utf8' });
    if (!r || r.error) return null;
    if (r.status !== 0) return null;
    const first = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return first || null;
  } catch (e) {
    return null;
  }
}

/**
 * 默认的 npm 包路径解析：@ffmpeg-installer/ffmpeg 等在不同平台解出不同的绝对路径。
 * 包缺失时返回 null 而非抛错（未 npm install 的开发环境要能降级到 PATH）。
 * @param {string} moduleId 包名
 * @returns {string|null} 二进制绝对路径
 */
function defaultResolveModuleBin(moduleId) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(moduleId);
    const p = mod && typeof mod.path === 'string' ? mod.path : '';
    return p || null;
  } catch (e) {
    return null;
  }
}

/** 外部二进制定位器。 */
class EnvDetector {
  /**
   * @param {{
   *   fs?: object,
   *   env?: object,
   *   platform?: string,
   *   binDir?: string,
   *   spawnWhich?: (cmd: string) => (string|null),
   *   resolveModuleBin?: (moduleId: string) => (string|null)
   * }} [deps] 依赖注入（单测用）
   */
  constructor(deps = {}) {
    this.fs = deps.fs || fsDefault;
    this.env = deps.env || process.env;
    this.platform = deps.platform || process.platform;
    this.binDir = deps.binDir || BIN_DIR;
    this.spawnWhich = typeof deps.spawnWhich === 'function' ? deps.spawnWhich : defaultSpawnWhich;
    this.resolveModuleBin =
      typeof deps.resolveModuleBin === 'function' ? deps.resolveModuleBin : defaultResolveModuleBin;
  }

  /**
   * 文件是否存在（异常一律视为不存在，绝不冒泡）。
   * @param {string} file 绝对路径
   * @returns {boolean}
   */
  fileExists(file) {
    if (!file) return false;
    try {
      return this.fs.existsSync(file) === true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 内置 bin 目录下的可执行文件名（Windows 带 .exe）。
   * @param {string} base 基名，如 'yt-dlp'
   * @returns {string} 绝对路径
   */
  builtinBinPath(base) {
    const ext = this.platform === 'win32' ? '.exe' : '';
    return path.join(this.binDir, base + ext);
  }

  /**
   * 通用解析：环境变量覆盖 > 内置 > PATH。
   * @param {{envKey: string, builtinBase?: string, moduleId?: string, pathCmd: string}} spec 解析规格
   * @returns {{path: string|null, source: string}} source: env|builtin|module|path|none
   */
  resolveTool(spec) {
    // ① 环境变量覆盖（不校验存在性由调用方决定；这里仍做一次存在性检查以免注入了错路径）
    const override = spec.envKey ? String(this.env[spec.envKey] || '').trim() : '';
    if (override) {
      if (this.fileExists(override)) return { path: override, source: 'env' };
      // 注入了路径但文件不在：仍然采纳（测试场景常注入虚拟路径），但标记来源便于排查
      return { path: override, source: 'env' };
    }

    // ② 项目内置：bin/ 下的单文件 exe
    if (spec.builtinBase) {
      const builtin = this.builtinBinPath(spec.builtinBase);
      if (this.fileExists(builtin)) return { path: builtin, source: 'builtin' };
    }

    // ② 项目内置：npm 安装包给出的绝对路径
    if (spec.moduleId) {
      const fromModule = this.resolveModuleBin(spec.moduleId);
      if (fromModule && this.fileExists(fromModule)) return { path: fromModule, source: 'module' };
    }

    // ③ 系统 PATH 兜底
    const onPath = this.spawnWhich(spec.pathCmd);
    if (typeof onPath === 'string' && onPath.trim()) return { path: onPath.trim(), source: 'path' };

    return { path: null, source: 'none' };
  }

  /**
   * 解析 yt-dlp 可执行路径。
   * @returns {{path: string|null, source: string}}
   */
  resolveYtDlp() {
    return this.resolveTool({ envKey: ENV_YT_DLP, builtinBase: 'yt-dlp', pathCmd: 'yt-dlp' });
  }

  /**
   * 解析 ffmpeg 可执行路径。
   * @returns {{path: string|null, source: string}}
   */
  resolveFfmpeg() {
    return this.resolveTool({
      envKey: ENV_FFMPEG,
      builtinBase: 'ffmpeg',
      moduleId: '@ffmpeg-installer/ffmpeg',
      pathCmd: 'ffmpeg',
    });
  }

  /**
   * 解析 ffprobe 可执行路径。
   * @returns {{path: string|null, source: string}}
   */
  resolveFfprobe() {
    return this.resolveTool({
      envKey: ENV_FFPROBE,
      builtinBase: 'ffprobe',
      moduleId: '@ffprobe-installer/ffprobe',
      pathCmd: 'ffprobe',
    });
  }

  /**
   * 一次性检测三件套。
   * @returns {{
   *   ytDlp: boolean, ffmpeg: boolean, ffprobe: boolean,
   *   ytDlpPath: string|null, ffmpegPath: string|null, ffprobePath: string|null,
   *   sources: {ytDlp: string, ffmpeg: string, ffprobe: string},
   *   missing: string[], guidance: string
   * }}
   */
  detect() {
    const yt = this.resolveYtDlp();
    const ff = this.resolveFfmpeg();
    const fp = this.resolveFfprobe();

    const missing = [];
    const tips = [];
    if (!yt.path) { missing.push('yt-dlp'); tips.push('yt-dlp: ' + YT_DLP_GUIDANCE); }
    if (!ff.path) { missing.push('ffmpeg'); tips.push('ffmpeg: ' + FFMPEG_GUIDANCE); }
    if (!fp.path) { missing.push('ffprobe'); tips.push('ffprobe: ' + FFPROBE_GUIDANCE); }

    return {
      ytDlp: !!yt.path,
      ffmpeg: !!ff.path,
      ffprobe: !!fp.path,
      ytDlpPath: yt.path,
      ffmpegPath: ff.path,
      ffprobePath: fp.path,
      sources: { ytDlp: yt.source, ffmpeg: ff.source, ffprobe: fp.source },
      missing,
      guidance: tips.join('  |  '),
    };
  }
}

EnvDetector.YT_DLP_GUIDANCE = YT_DLP_GUIDANCE;
EnvDetector.FFMPEG_GUIDANCE = FFMPEG_GUIDANCE;
EnvDetector.FFPROBE_GUIDANCE = FFPROBE_GUIDANCE;

module.exports = {
  EnvDetector,
  defaultSpawnWhich,
  defaultResolveModuleBin,
  HUB_DIR,
  BIN_DIR,
  ENV_YT_DLP,
  ENV_FFMPEG,
  ENV_FFPROBE,
  YT_DLP_GUIDANCE,
  FFMPEG_GUIDANCE,
  FFPROBE_GUIDANCE,
};
