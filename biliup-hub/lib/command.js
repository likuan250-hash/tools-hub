// lib/command.js —— 命令拼装 + 临时脚本执行（biliup-cli v0.2.4 实参语法核心）
//
// 已知坑点（见 docs/system_design.md §1.3）：
//   1) --extra-fields 在 subprocess 列表模式不生效 → 完整命令写入临时脚本文件再执行。
//   2) 简介多行：ps1 的 desc 换行用 `n，文件必须 utf-8-sig（带 BOM）。
//   3) 双引号在 ps1 内用反引号 ` 转义（" → `"）。
//   4) 执行：powershell -NoProfile -ExecutionPolicy Bypass -File <tmp>。
//
// biliup-cli v0.2.4 真实 CLI 参数（实测 bin/biliup.exe --help / upload --help）：
//   全局: -u, --user-cookie <FILE>  登录信息文件（必须放在 upload 之前）
//   子命令: upload [OPTIONS] [VIDEO_PATH]...
//     --cover --title --tid --tag(逗号分隔单值) --copyright --no-reprint
//     --line --desc --dtime
//   注意：v0.2.4【不认识】--video-file 与 --cookies：
//     - 视频文件是 upload 之后的【位置参数】
//     - 鉴权走全局 -u（指向 biliup 的 LoginInfo 文件，非扁平 web cookie）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const logger = require('./logger');
// 仅用于兜底解析 LoginInfo 文件路径（真实运行 config 已携带 loginInfoPath）。
// 这里 require store 不会形成循环依赖（store 仅依赖 biliupBin）。
const store = require('./store');

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
//
// biliup-cli v0.2.4 真实语法（见 bin/biliup.exe upload --help / --help）：
//   全局参数（必须放在子命令之前）：
//     -u, --user-cookie <FILE>   登录信息文件（biliup 的 LoginInfo 结构，非扁平 web cookie）
//   子命令：upload [OPTIONS] [VIDEO_PATH]...
//     --video-file 不存在 → 视频文件是 upload 之后的【位置参数】，可多个
//     --cookies 不存在 → 鉴权走全局 -u
//     --tag 为【单个逗号分隔值】（--tag a,b,c），不能逐个 -t 分散
//     其余 --title/--tid/--copyright/--no-reprint/--line/--desc/--cover/--dtime 均为真实 flag
//
// @param {Object} req { videoPath, title, tags, desc, publishMode, dtime }
// @param {Object} cfg { biliupExePath, tid, copyright, noReprint, line, loginInfoPath, tags }
// @param {string} [coverPath] 封面 png 路径（可选）
// @param {{quote?:Function, multiLine?:Function}} [opts] 引号转义函数（ps1/bat 各一套）
// @returns {string[]} 完整有序参数数组：[-u <loginInfo>, upload, ...flags, <videoPath>]
function buildArgs(req, cfg, coverPath, opts = {}) {
  const quote = typeof opts.quote === 'function' ? opts.quote : ps1Quote;
  const multiLine = typeof opts.multiLine === 'function' ? opts.multiLine : ps1MultiLine;

  // biliup 登录信息文件（LoginInfo 结构）：优先用 config 注入，兜底取 store 默认路径。
  const loginInfoPath = (cfg && cfg.loginInfoPath)
    || (store && store.getLoginInfoPath ? store.getLoginInfoPath() : '');

  const args = [];
  // ① 全局参数 -u 必须放在子命令 upload 之前（v0.2.4 全局位置）。
  if (loginInfoPath) {
    args.push('-u', quote(loginInfoPath));
  }
  // ② 子命令。
  args.push('upload');
  // ③ 封面（可选）。
  if (coverPath) args.push('--cover', quote(coverPath));
  // ④ 标题 / 分区。
  args.push('--title', quote(req.title || ''));
  args.push('--tid', String(cfg.tid));
  // ⑤ 标签：多个 tag 合并成【单个逗号分隔值】——v0.2.4 要求 --tag a,b,c 形态。
  const tags = (req.tags && req.tags.length) ? req.tags : (cfg.tags || []);
  const tagStr = tags.filter((t) => t).join(',');
  if (tagStr) args.push('--tag', quote(tagStr));
  // ⑥ 版权 / 转载限制。
  args.push('--copyright', String(cfg.copyright));
  args.push('--no-reprint', String(cfg.noReprint));
  // ⑦ 上传线路。
  args.push('--line', quote(cfg.line));
  // ⑧ 简介（多行用 multiLine 转义）。
  args.push('--desc', multiLine(req.desc || ''));
  // ⑨ 延时发布（仅 dtime 模式且提供了时间戳）。
  if (req.publishMode === 'dtime' && req.dtime) {
    args.push('--dtime', String(req.dtime));
  }
  // ⑩ 视频文件：位置参数，放在 upload 之后、所有 flag 之后（v0.2.4 语法，绝不能用 --video-file）。
  args.push(quote(req.videoPath));
  return args;
}

/**
 * 生成 PowerShell 临时脚本内容（utf-8-sig 编码、反引号转义、多行 desc）。
 * 注：不再写 @chcp 65001 —— 该语法是 cmd 写法，写在 .ps1 里会被 PowerShell 当作 splatting 解析报错；
 * 文件已由 writeTempScript 以 utf-8-sig（带 BOM）写入，编码正确无需 chcp。
 * @param {Object} req { videoPath, title, tags, desc, publishMode, dtime }
 * @param {Object} cfg { biliupExePath, tid, copyright, noReprint, line, cookiesPath, tags }
 * @param {string} [coverPath] 封面 png 路径（可选）
 * @returns {{path:string, content:string, shell:string}}
 */
function buildPs1(req, cfg, coverPath) {
  const exe = cfg.biliupExePath;
  const args = buildArgs(req, cfg, coverPath, { quote: ps1Quote, multiLine: ps1MultiLine });
  const content = [
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
  // 复用 buildArgs，bat 用 batQuote（"" 转义），desc 单行用 batQuote 即可。
  const args = buildArgs(req, cfg, coverPath, { quote: batQuote, multiLine: batQuote });
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
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 *   向后兼容：旧调用方解构 { stdout, stderr } 仍可用，新增的 code 不破坏既有用法。
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
      // 透传 exit code：成功路径 code=0；失败路径取 err.code 或 child.exitCode，
      // 以便上层区分「真上传成功」vs「exit0 但无标识」（根治铺路）。
      const code = err ? (err.code ?? child.exitCode) : 0;
      if (err) {
        onError(stderr || err.message);
        const execErr = new Error('biliup 执行失败: ' + (stderr || err.message));
        // 可选：为 reject 的 Error 附带 exit code，便于上游早报/治理。
        if (code !== null && code !== undefined) execErr.code = code;
        return reject(execErr);
      }
      resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
    if (child.stdout) child.stdout.on('data', (d) => onLog(d.toString()));
    if (child.stderr) child.stderr.on('data', (d) => onError(d.toString()));
  });
}

module.exports = {
  buildArgs,
  buildPs1,
  buildBat,
  writeTempScript,
  runViaTempScript,
  ps1Quote,
  ps1MultiLine,
  batQuote,
  TMP_DIR,
};
