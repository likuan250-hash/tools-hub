// resolve-hub 纯函数工具（可单测，不依赖 http/fs 单例）
const path = require("path");

const DEFAULT_SUFFIX = "官方中文+全DLC+免安装硬盘版 免费学习版下载";
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

function collapse(s) {
  return String(s == null ? "" : s)
    .replace(/\s+/g, " ")
    .trim();
}

/** 项目名：去掉路径分隔符/非法字符，空则返回 ""（由调用方报错） */
function sanitizeProjectName(raw) {
  return collapse(String(raw == null ? "" : raw).replace(ILLEGAL_NAME_CHARS, "_")).slice(0, 100);
}

/** 输出名：去 .mp4 后缀、非法字符、首尾点/空格、长度限制；空/无效回退默认规则 */
function sanitizeOutName(raw, projectName) {
  const project = sanitizeProjectName(projectName) || "未命名项目";
  let s = String(raw == null ? "" : raw)
    .trim()
    .replace(/\.mp4$/i, "");
  s = s.replace(ILLEGAL_NAME_CHARS, "_");
  s = s.replace(/_{2,}/g, "_");
  s = collapse(s).replace(/^[.\s]+|[.\s]+$/g, "");
  if (!s || s === "." || s === "..") s = `${project} ${DEFAULT_SUFFIX}`;
  return s.slice(0, 120).trim() || `${project} ${DEFAULT_SUFFIX}`;
}

function defaultOutName(projectName) {
  return sanitizeOutName("", projectName);
}

/** 只允许本机回环 Origin（webview 同源），无 Origin（OAuth/顶层导航/curl）放行 */
function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch (e) {
    return false;
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 在 target 目录里找这次渲染真正生成的文件：
 * DaVinci 遇到同名文件会生成 "名字 (1).mp4" / "名字 (2).mp4"，所以不能只认精确文件名。
 */
function findRenderedFile(dir, baseName, fsImpl = require("fs")) {
  const base = String(baseName || "").replace(/\.mp4$/i, "");
  if (!base) return null;
  const re = new RegExp("^" + escapeRe(base) + "(?: \\(\\d+\\))?\\.mp4$", "i");
  let best = null;
  let names = [];
  try {
    names = fsImpl.readdirSync(dir);
  } catch (e) {
    return null;
  }
  for (const name of names) {
    if (!re.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = fsImpl.statSync(full);
      if (!st.isFile() || st.size <= 0) continue;
      if (!best || st.mtimeMs >= best.mtimeMs)
        best = { path: full, size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      /* 忽略单个文件的错误 */
    }
  }
  return best;
}

/** 服务端在子进程结束时写入 __RESOLVE_EXIT__=<code>，前端据此判断成功与否 */
const EXIT_MARKER = "__RESOLVE_EXIT__";
function parseExitMarker(text) {
  const m = String(text || "").match(new RegExp(EXIT_MARKER + "=(\\d+)", "g"));
  if (!m || !m.length) return null;
  const last = m[m.length - 1].split("=")[1];
  return Number(last);
}
function stripExitMarker(text) {
  return String(text || "").replace(new RegExp("\\n?" + EXIT_MARKER + "=\\d+\\n?", "g"), "\n");
}

module.exports = {
  DEFAULT_SUFFIX,
  sanitizeProjectName,
  sanitizeOutName,
  defaultOutName,
  isAllowedOrigin,
  findRenderedFile,
  parseExitMarker,
  stripExitMarker,
  escapeRe,
};
