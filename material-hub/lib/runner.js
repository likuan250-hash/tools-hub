// lib/runner.js —— 外部命令执行器（yt-dlp / ffmpeg / ffprobe 共用的唯一 spawn 封装）
//
// 抽出背景：原实现把 runCommand 内联在 lib/trailer.js 里，lib/probe.js 需要复用时
// 只能反向 require('./trailer')，会形成 trailer ↔ probe 循环依赖。故独立成本模块，
// 依赖方向统一为：trailer.js / probe.js → runner.js（单向，无环）。
//
// 约定：
//   · spawn 一律经参数注入（opts.spawn），单测不启动任何真实进程；
//   · 超时强杀，reject 带 code='ETIMEDOUT'，避免 SSE 长流被子进程卡死；
//   · stdout/stderr 逐行回调，供上层实时推送运行日志。
const { spawn: spawnDefault } = require('child_process');

/** 默认超时（20min，覆盖大文件下载/转码）。 */
const DEFAULT_TIMEOUT = 20 * 60 * 1000;

/**
 * 运行外部命令，逐行回调 stdout/stderr。
 * @param {string} cmd 命令名或可执行文件绝对路径
 * @param {string[]} args 参数数组
 * @param {{
 *   spawn?: Function,
 *   onLine?: (line: string, stream: string) => void,
 *   timeout?: number,
 *   cwd?: string,
 *   env?: object
 * }} [opts] 选项；spawn 用于单测注入，env 注入子进程环境变量
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} 进程退出信息
 */
function runCommand(cmd, args, opts = {}) {
  const spawnFn = opts.spawn || spawnDefault;
  const onLine = typeof opts.onLine === 'function' ? opts.onLine : () => {};
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_TIMEOUT;
  return new Promise((resolve, reject) => {
    let child = null;
    try {
      // 中文 Windows 下 yt-dlp 默认输出 GBK，Node.js 读成 UTF-8 即乱码。
      // 注入 PYTHONUTF8=1 强制 Python 用 UTF-8，同时兜底其他外部命令不受影响。
      const spawnOpts = { windowsHide: true, cwd: opts.cwd };
      if (opts.env) spawnOpts.env = opts.env;
      child = spawnFn(cmd, args, spawnOpts);
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let tailOut = '';
    let tailErr = '';

    const pump = (chunk, stream) => {
      const text = String(chunk);
      if (stream === 'stdout') { stdout += text; tailOut += text; } else { stderr += text; tailErr += text; }
      let buf = stream === 'stdout' ? tailOut : tailErr;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line, stream);
      }
      if (stream === 'stdout') tailOut = buf; else tailErr = buf;
    };

    if (child.stdout && child.stdout.on) child.stdout.on('data', (c) => pump(c, 'stdout'));
    if (child.stderr && child.stderr.on) child.stderr.on('data', (c) => pump(c, 'stderr'));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* 进程已退出 */ }
      const err = new Error(cmd + ' 执行超时（' + Math.round(timeout / 1000) + 's）');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeout);
    if (timer.unref) timer.unref();

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

module.exports = { runCommand, DEFAULT_TIMEOUT };
