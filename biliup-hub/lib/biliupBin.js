// lib/biliupBin.js —— 解析 biliup.exe 真实路径（#6）
// 打包后：<resources>/biliup-hub/bin/biliup.exe（随安装包内置）
// 开发期（resourcesPath 不存在时）：回退 D:\biliupR\biliup.exe 方便本地调试
//
// 注意：fork 出的子进程没有 process.resourcesPath（仅 Electron 主进程有），
// 因此主进程会把资源目录经环境变量 TOOLSHUB_RESOURCES_DIR 注入子进程。
const path = require('path');

// 开发期回退路径（与历史默认保持一致，方便本机调试）
const DEV_FALLBACK = 'D:\\biliupR\\biliup.exe';

/**
 * 解析资源目录：
 *   1) 主进程注入的 TOOLSHUB_RESOURCES_DIR（打包后有效，fork 子进程唯一可靠来源）
 *   2) 否则回退 process.resourcesPath（仅 Electron 主进程/渲染进程有效）
 *   3) 都没有 → 返回 null（视为开发期）
 * @returns {string|null}
 */
function resolveResourcesDir() {
  const fromEnv = process.env.TOOLSHUB_RESOURCES_DIR;
  if (fromEnv && typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  if (process.resourcesPath) return process.resourcesPath;
  return null;
}

/**
 * 解析 biliup.exe 绝对路径。
 * @returns {string}
 */
function resolveBiliupBin() {
  const resDir = resolveResourcesDir();
  if (resDir) {
    return path.join(resDir, 'biliup-hub', 'bin', 'biliup.exe');
  }
  return DEV_FALLBACK;
}

const BILIUP_BIN = resolveBiliupBin();

module.exports = { resolveBiliupBin, resolveResourcesDir, BILIUP_BIN, DEV_FALLBACK };
