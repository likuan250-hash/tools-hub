// 主进程（Electron）中「不依赖 electron 运行时」的纯函数，抽到此处独立单测。
// main.js 通过 require 复用，保证行为与单测一致；打包后由 build.files 的 lib/**/* 包含。
const fs = require("fs");
const path = require("path");

// 把任意日志参数安全转成字符串（Error 取 stack/message，对象 JSON 化，兜底 String）。
function safeStr(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch (e) {
    return String(a);
  }
}

// 递归拷贝目录树（用于升级时把安装目录残留数据迁移到 userData）。
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { safeStr, copyDir };
