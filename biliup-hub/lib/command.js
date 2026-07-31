// lib/command.js —— 命令拼装 + 临时脚本执行（biliup-rs 坑点核心）
//
// 已知坑点（见 docs/system_design.md §1.3）：
//   1) --extra-fields 在 subprocess 列表模式不生效 → 完整命令写入临时脚本文件再执行。
//   2) 简介多行：ps1 的 desc 换行用 `n，文件必须 utf-8-sig（带 BOM）。
//   3) 双引号在 ps1 内用反引号 ` 转义（" → `"）。
//   4) 执行：powershell -NoProfile -ExecutionPolicy Bypass -File <tmp>。
//
// biliup-rs CLI 参数名（v1.2.1 形态，见设计 §8.1，待实测确认）：
//   upload --video-file --cover --title --tid --tag --copyright --no-reprint
//          --line --desc --dtime --cookies
// 注意：若实际 biliup 版本不接受 --video-file，应改为位置参数 <FILE>（见 buildPs1 顶部 TODO）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const logger = require('./logger');

const TMP_DIR = path.join(__dirname, '..', '.tmp');

// ── PowerShell 字符串转义 ──
// 在 ps1 双引号字符串内，双引号需转义为 `"（反引号+双引号）。
function ps1Quote(value) {
  const escaped = String(value == null ? '' : value).replace(/"/g, '`"');
  return '"' + escaped + '"';
}
// 多行 desc：换行 → `n，双引号 → `"，整体包双引号（坑点2/3）。
function ps1MultiLine(value) {
  const escaped = String(value == null ? '' : value)
    .replace(/"/g, '`"')
    .replace(/\r\n|\r|\n/g, '`n');
  return '"' + escaped + '"';
}
// bat 兜底：双引号用 "" 转义；不支持多行（多行场景一律走 ps1）。
function batQuote(value) {
  const escaped = String(value == null ? '' : value).replace(/"/g, '""');
  return '"' + escaped + '"';
}

// ── 拼装 biliup 参数数组（不含 exe 调用符）──
function buildArgs(req, cfg, coverPath) {
  const args = ['upload'];
  args.push('--video-file', ps1Quote(req.videoPath));
  if (coverPath) args.push('--cover', ps1Quote(coverPath));
  args.push('--title', ps1Quote(req.title || ''));
  args.push('--tid', String(cfg.tid));
  const tags = (req.tags && req.tags.length) ? req.tags : (cfg.tags || []);
  for (const t of tags) {
    if (t) args.push('--tag', ps1Quote(t));
  }
  args.push('--copyright', String(cfg.copyright));
  args.push('--no-reprint', String(cfg.noReprint));
  args.push('--line', ps1Quote(cfg.line));
  args.push('--desc', ps1MultiLine(req.desc || ''));
  if (req.publishMode === 'dtime' && req.dtime) {
    args.push('--dtime', String(req.dtime));
  }
  args.push('--cookies', ps1Quote(cfg.cookiesPath));
  return args;
}

/**
 * 生成 PowerShell 临时脚本内容（utf-8-sig 编码、头部 @chcp 65001、反引号转义、多行 desc）。
 * @param {Object} req { videoPath, title, tags, desc, publishMode, dtime }
 * @param {Object} cfg { biliupExePath, tid, copyright, noReprint, line, cookiesPath, tags }
 * @param {string} [coverPath] 封面 png 路径（可选）
 * @returns {{path:string, content:string, shell:string}}
 */
function buildPs1(req, cfg, coverPath) {
  // TODO(实测): biliup-rs v1.2.1 若不接受 --video-file，改为位置参数：exe + " " + ps1Quote(videoPath) + " upload ..."
  const exe = cfg.biliupExePath;
  const args = buildArgs(req, cfg, coverPath);
  const content = [
    '@chcp 65001 >nul',                 // 强制 UTF-8 代码页（坑点3，避免中文乱码）
    '& ' + ps1Quote(exe) + ' ' + args.join(' '),
  ].join('\n');
  return { path: '', content, shell: 'ps1' };
}

/**
 * 生成 .bat 兜底脚本（仅用于 desc 无多行场景；bat 不支持多行 desc）。
 * @returns {{path:string, content:string, shell:string}}
 */
function buildBat(req, cfg, coverPath) {
  const exe = cfg.biliupExePath;
  // bat 不支持多行 desc：若 desc 含换行，强制改用 ps1（调用方应优先选 ps1）。
  if (/[\r\n]/.test(req.desc || '')) {
    return buildPs1(req, cfg, coverPath);
  }
  const args = ['upload'];
  args.push('--video-file', batQuote(req.videoPath));
  if (coverPath) args.push('--cover', batQuote(coverPath));
  args.push('--title', batQuote(req.title || ''));
  args.push('--tid', String(cfg.tid));
  const tags = (req.tags && req.tags.length) ? req.tags : (cfg.tags || []);
  for (const t of tags) {
    if (t) args.push('--tag', batQuote(t));
  }
  args.push('--copyright', String(cfg.copyright));
  args.push('--no-reprint', String(cfg.noReprint));
  args.push('--line', batQuote(cfg.line));
  args.push('--desc', batQuote(req.desc || ''));
  if (req.publishMode === 'dtime' && req.dtime) {
    args.push('--dtime', String(req.dtime));
  }
  args.push('--cookies', batQuote(cfg.cookiesPath));
  const content = '@echo off\r\n' + '"' + exe + '" ' + args.join(' ');
  return { path: '', content, shell: 'bat' };
}

/**
 * 将脚本以 utf-8-sig（带 BOM）写入临时目录，返回临时文件路径。
 * 供 runViaTempScript 与单测断言 BOM 使用。
 * @param {{content:string, shell:string}} scriptFile
 * @param {string} [dir] 可选自定义目录（单测用）
 * @returns {string} 临时文件路径
 */
function writeTempScript(scriptFile, dir) {
  const baseDir = dir || TMP_DIR;
  fs.mkdirSync(baseDir, { recursive: true });
  const ext = scriptFile.shell === 'bat' ? 'bat' : 'ps1';
  const tmpPath = path.join(baseDir, `biliup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  // 关键：utf-8-sig 编码（带 BOM），PowerShell 才能正确识别 UTF-8（坑点3）。
  // Node 的 fs 无 'utf-8-sig' 别名，故手动前置 BOM(EF BB BF) + utf8 内容。
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  fs.writeFileSync(tmpPath, Buffer.concat([bom, Buffer.from(scriptFile.content, 'utf8')]));
  return tmpPath;
}

/**
 * 通过临时脚本文件执行 biliup（绕开 --extra-fields 列表模式失效坑点）。
 * @param {{content:string, shell:string}} scriptFile
 * @param {{onLog?:Function, onError?:Function, deps?:Object}} [opts]
 *   opts.deps.execFile 可注入（单测 mock）；默认 child_process.execFile。
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
function runViaTempScript(scriptFile, opts = {}) {
  const deps = Object.assign({ execFile }, opts.deps || {});
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};

  // v1 仅保证 Windows 可用（与现有工具一致）；非 Windows 路径留 TODO 不崩溃进程。
  if (process.platform !== 'win32') {
    return Promise.reject(
      new Error('runViaTempScript 当前仅支持 Windows（v1）。非 Windows 环境暂不支持：请改用 bash 脚本拼装（TODO）。')
    );
  }

  return new Promise((resolve, reject) => {
    let tmpPath;
    try {
      tmpPath = writeTempScript(scriptFile);
    } catch (e) {
      return reject(new Error('写入临时脚本失败: ' + e.message));
    }
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch (_) {} };
    let file, args;
    if (scriptFile.shell === 'bat') {
      file = 'cmd';
      args = ['/c', tmpPath];
    } else {
      file = 'powershell'; // 默认 ps1
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPath];
    }
    const child = deps.execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      cleanup();
      if (err) {
        onError(stderr || err.message);
        return reject(new Error('biliup 执行失败: ' + (stderr || err.message)));
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
    if (child.stdout) child.stdout.on('data', (d) => onLog(d.toString()));
    if (child.stderr) child.stderr.on('data', (d) => onError(d.toString()));
  });
}

module.exports = {
  buildPs1,
  buildBat,
  writeTempScript,
  runViaTempScript,
  ps1Quote,
  ps1MultiLine,
  batQuote,
  TMP_DIR,
};
