// ── 游戏库云服务客户端（game-fix-manual）──
// 职责收敛为三件事：登录换 token / 查重 / 新增入库（可选补传封面）。
// 与金山那条线路**完全独立**：这里抛出的任何错误都只代表云库这条线路失败，
// 调用方（executor）必须自行 try/catch 降级，绝不能让云库拖垮 kdocs 主流程。
//
// ⚠️ 三条实测铁律（2026-09-24 实机验证，见桌面 games-api.md）：
//   1) 登录态调用**必须带 Origin**，且 signin 与后续调用必须**完全一致**；
//      token 与签发时的 Origin 强绑定 —— 用发布域签的 token 换 localhost 调，同样 401 invalid_grant。
//      报 invalid_grant 时先怀疑 Origin，别当成密码错。
//   2) games_admin_page 的 p_status 只认 all / live / deleted / nocover。
//      传空串会让 WHERE 恒假、**静默返回 0 条** —— 查重会永远查不到重名然后插重复数据。
//      这里硬编码 "all"，**绝不透传任何外部输入**。
//   3) games_admin_save 的 insert 分支不接受封面字段（只认 12 个键）。
//      新入库默认无封面，需另调 games_admin_cover_set 补 thumb / full 两档。
//
// 安全边界（与 import_game.py 同构）：p_id 恒传 null → 物理上不可能改到或删掉已有记录。

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

/** 发布域。cloud 侧 Origin 白名单只认它 + localhost 系，取发布域最省事。 */
const EP = process.env.GAMECLOUD_EP || "https://game-fix-manual.app.workbuddy.host";
/** 可发布密钥：写在网页里，属公开信息，真正的鉴权是 Bearer token。 */
const PK = process.env.GAMECLOUD_PK || "wbpk_3qUxv314m1RnrXt5XpXAZT_0y1edEi9YhRLv2r9kigtmfDgvrcf0wyb";
/** 管理员邮箱：不硬编码 —— env GAMECLOUD_EMAIL 优先，其次 userData/kdocs-tool/gamecloud.json 的 email */
function resolveAdminEmail() {
  const envMail = String(process.env.GAMECLOUD_EMAIL || "").trim();
  if (envMail) return envMail;
  try {
    const base =
      process.env.KDOCS_DATA_DIR ||
      path.join(process.env.APPDATA || "", "tools-hub", "kdocs-tool", "data");
    const j = JSON.parse(fs.readFileSync(path.join(base, "..", "gamecloud.json"), "utf8"));
    return String((j && j.email) || "").trim();
  } catch (e) {
    return "";
  }
}
const ADMIN_EMAIL = resolveAdminEmail();
/** ⚠️ 必须与 signin 用的一致：token 与签发时的 Origin 强绑定。 */
const ORIGIN = EP;

/** 封面压缩规格（云库要求，超了会把列表接口响应撑爆）。 */
const THUMB_SIDE = 200, THUMB_Q = 6;
const FULL_SIDE = 1000, FULL_Q = 4;

/** access_token 有效期约 7199s；提前 60s 视为过期，避免边界失败。 */
const TOKEN_SAFETY_MS = 60 * 1000;

/** 进程内 token 缓存。不落盘 —— 密码才是长期凭据，token 两小时就过期。 */
let _token = "";
let _tokenAt = 0;
let _tokenExp = 0;

/** 未配置密码时抛出的专用错误码，供上层识别并给出可操作提示。 */
const ERR_NO_PASSWORD = "NO_PASSWORD";

function makeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 密码来源：显式传入 > 环境变量。两者都没有就是没配置。 */
function resolvePassword(opts = {}) {
  const pw = String(opts.password || process.env.QQBOT_ADMIN_PASSWORD || "").trim();
  return pw;
}

/** 是否已配置密码（上层据此决定要不要跑云库这条线路）。 */
function hasCredentials(opts = {}) {
  return !!resolvePassword(opts);
}

/** 本地日期 YYYY-MM-DD（云库 doc_date 只认这个格式，斜杠会被静默存 NULL）。 */
function todayDash() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 名称归一：查重必须自己再精确比对一次（p_q 是 ILIKE 模糊匹配）。 */
function normName(s) {
  return String(s == null ? "" : s).trim().toLowerCase();
}

/**
 * 发一个 JSON 请求。
 * @param {string} method
 * @param {string} urlPath 以 / 开头的路径
 * @param {object|null} body
 * @param {object} headers
 * @param {number} timeout
 * @returns {Promise<{status:number, json:object|null, raw:string}>}
 */
function httpJson(method, urlPath, body, headers, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(EP + urlPath);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: Object.assign(
          { "x-wb-webapp-access-key": PK, Origin: ORIGIN },
          payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
          headers || {},
        ),
        timeout,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw || "{}"); } catch { json = null; }
          resolve({ status: res.statusCode || 0, json, raw });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("请求超时（" + timeout + "ms）：" + urlPath)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 换 token（密码登录）。
 * 参数名是 username，**不是 email** —— 传 email 会返回 "username or verification_token can not both be empty"，
 * 看着像缺参数，其实是名字不对。
 * @param {object} [opts] {password?:string, force?:boolean}
 * @returns {Promise<string>} access_token
 */
async function getToken(opts = {}) {
  const now = Date.now();
  if (!opts.force && _token && now - _tokenAt < _tokenExp - TOKEN_SAFETY_MS) return _token;

  const password = resolvePassword(opts);
  if (!password) {
    throw makeError(
      ERR_NO_PASSWORD,
      "未配置云库后台密码（环境变量 QQBOT_ADMIN_PASSWORD），云库线路已跳过",
    );
  }
  // opts._http 仅供单测注入（默认走真实 https）；生产路径永远不传
  const send = typeof opts._http === "function" ? opts._http : httpJson;
  const r = await send("POST", "/.cloud/auth/v1/signin", {
    username: opts.email || ADMIN_EMAIL,
    password,
  });
  const tok = (r.json && r.json.access_token) || "";
  if (r.status !== 200 || !tok) {
    const code = (r.json && (r.json.code || r.json.error)) || r.status;
    const desc = (r.json && (r.json.error_description || r.json.message)) || r.raw.slice(0, 160);
    if (String(code) === "invalid_grant") {
      throw makeError("SIGNIN_ORIGIN", `登录失败：invalid_grant — ${desc}（这不是密码错，是 Origin 与签发时不一致）`);
    }
    if (/invalid_username_or_password/i.test(String(code))) {
      throw makeError("SIGNIN_BAD_PASSWORD", `登录失败：邮箱或密码不对（${code}）`);
    }
    throw makeError("SIGNIN_FAILED", `登录失败：HTTP ${r.status} ${code} — ${desc}`);
  }
  _token = tok;
  _tokenAt = now;
  _tokenExp = (Number(r.json.expires_in) || 7200) * 1000;
  return _token;
}

/** 清掉缓存 token（401 重登前调用）。 */
function invalidateToken() {
  _token = "";
  _tokenAt = 0;
  _tokenExp = 0;
}

/**
 * 带鉴权的调用：遇 401 / invalid_grant 自动重登一次再重试（最多一次，防死循环）。
 * @returns {Promise<object>} {status, json, raw}
 */
async function callAuthed(urlPath, body, opts = {}) {
  const send = typeof opts._http === "function" ? opts._http : httpJson;
  let token = await getToken(opts);
  let r = await send("POST", urlPath, body, { Authorization: "Bearer " + token });
  if (r.status === 401) {
    invalidateToken();
    token = await getToken({ ...opts, force: true });
    r = await send("POST", urlPath, body, { Authorization: "Bearer " + token });
  }
  return r;
}

/**
 * 查重：按名称精确比对已有记录。
 * p_status 硬编码 "all"（传空串会静默返回 0 条，见文件头铁律 2）。
 * @param {string} name
 * @param {object} [opts]
 * @returns {Promise<object|null>} 命中的行；无命中返回 null
 */
async function findDup(name, opts = {}) {
  const r = await callAuthed(
    "/.cloud/database/rest/rpc/games_admin_page",
    { p_q: name, p_status: "all", p_order: "desc", p_limit: 50, p_offset: 0 },
    opts,
  );
  if (r.status !== 200) {
    const desc = (r.json && (r.json.message || r.json.error)) || r.raw.slice(0, 160);
    throw makeError("DUP_CHECK_FAILED", `查重失败：HTTP ${r.status} — ${desc}`);
  }
  const rows = (r.json && r.json.rows) || [];
  const want = normName(name);
  for (const row of rows) {
    if (normName(row && row.name) === want) return row;
  }
  return null;
}

/**
 * 新增入库（p_id 恒为 null，只增不改不删）。
 * @param {object} row p_row 字段
 * @param {object} [opts]
 * @returns {Promise<{id:number|string, action:string}>}
 */
async function insert(row, opts = {}) {
  const r = await callAuthed(
    "/.cloud/database/rest/rpc/games_admin_save",
    { p_id: null, p_row: row },
    opts,
  );
  if (r.status !== 200) {
    const code = (r.json && (r.json.code || r.json.error)) || r.status;
    const desc = (r.json && (r.json.message || r.json.error_description)) || r.raw.slice(0, 160);
    if (String(code) === "22023") throw makeError("INSERT_BAD_ARGS", `入库被拒（22023 参数错）：${desc}`);
    if (String(code) === "42501") throw makeError("INSERT_NO_PERM", `入库被拒（42501 权限）：账号不在 app_admin 白名单？${desc}`);
    throw makeError("INSERT_FAILED", `入库失败：HTTP ${r.status} ${code} — ${desc}`);
  }
  return { id: r.json && r.json.id, action: (r.json && r.json.action) || "insert" };
}

/** ffmpeg 可执行路径：环境变量 > PATH。压图用它，不需要给 kdocs-tool 加任何图片依赖。 */
function ffmpegBin() {
  const override = String(process.env.KDOCS_FFMPEG_BIN || "").trim();
  if (override) return override;
  const rel = path.join("material-hub", "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe");
  const cands = [
    process.env.TOOLSHUB_RESOURCES_DIR ? path.join(process.env.TOOLSHUB_RESOURCES_DIR, rel) : "",
    path.resolve(__dirname, "..", "..", rel), // dev：仓库内 material-hub 的副本
  ].filter(Boolean);
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) { /* 继续找下一个 */ }
  }
  throw makeError("FFMPEG_NOT_FOUND", "未找到应用自带的 ffmpeg（可用 KDOCS_FFMPEG_BIN 指定）");
}

/** 跑一条命令（不带 shell，避免引号问题）。 */
function runCmd(bin, args, timeout = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stderr: e.message });
    }
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, timeout);
    child.stderr && child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stderr: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

/**
 * 压成 JPEG 并转 data URI。
 * 长边不超过 side，**不放大**（小图保持原尺寸），质量用 ffmpeg 的 q 值控制。
 * @param {string} srcPath 源图
 * @param {number} side 长边上限
 * @param {number} q ffmpeg -q:v（越小越清晰、体积越大）
 * @returns {Promise<string>} data:image/jpeg;base64,...
 */
async function toDataUri(srcPath, side, q) {
  const tmp = path.join(os.tmpdir(), `gc-cover-${side}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const vf = `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease`;
  const r = await runCmd(ffmpegBin(), ["-y", "-i", srcPath, "-vf", vf, "-frames:v", "1", "-q:v", String(q), tmp]);
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    throw makeError("COVER_COMPRESS_FAILED", "封面压缩失败（ffmpeg）：" + String(r.stderr || "").slice(-200));
  }
  try {
    const buf = fs.readFileSync(tmp);
    return "data:image/jpeg;base64," + buf.toString("base64");
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主流程 */ }
  }
}

/**
 * 补传封面（thumb + full 各一次）。必须在入库拿到 id 之后调用。
 * @param {number|string} id 游戏记录 id
 * @param {string} imgPath 本地封面图路径
 * @param {object} [opts]
 * @returns {Promise<{thumb:string, full:string}>} 各档写入结果状态
 */
async function setCover(id, imgPath, opts = {}) {
  if (!id) throw makeError("COVER_NO_ID", "缺少记录 id，无法补传封面");
  if (!imgPath || !fs.existsSync(imgPath)) throw makeError("COVER_NO_FILE", "封面文件不存在：" + imgPath);
  const uriThumb = await toDataUri(imgPath, THUMB_SIDE, THUMB_Q);
  const uriFull = await toDataUri(imgPath, FULL_SIDE, FULL_Q);
  const out = {};
  for (const [kind, uri] of [["thumb", uriThumb], ["full", uriFull]]) {
    const r = await callAuthed(
      "/.cloud/database/rest/rpc/games_admin_cover_set",
      { p_id: id, p_kind: kind, p_mime: "image/jpeg", p_data_uri: uri },
      opts,
    );
    if (r.status !== 200) {
      const desc = (r.json && (r.json.message || r.json.error)) || r.raw.slice(0, 160);
      throw makeError("COVER_SET_FAILED", `封面 ${kind} 写入失败：HTTP ${r.status} — ${desc}`);
    }
    out[kind] = "ok";
  }
  return out;
}

/** 入库允许的键（insert 分支只认这些，多传会被忽略）。 */
const ROW_KEYS = ["name", "intro", "size", "ar", "hits", "tags",
  "doc_date", "doc_date_raw", "url_quark", "url_baidu", "url_xunlei", "url_mobile"];

/**
 * 由 kdocs 的解析结果组装云库 p_row。纯函数，便于单测。
 * 字段映射：游戏名称→name / 大小→size / 分类标签→tags / 日期→doc_date（YYYY-MM-DD）/
 *          三家网盘→url_baidu·url_quark·url_xunlei。
 * @param {object} parsed parseInput 的结果
 * @param {{gameSize?:string, tags?:string[], intro?:string, date?:string}} [extra]
 * @returns {object} p_row
 */
function buildRow(parsed, extra = {}) {
  const row = { name: String((parsed && parsed.raw) || "").trim() };
  if (extra.intro) row.intro = String(extra.intro).trim();
  if (extra.gameSize) row.size = String(extra.gameSize).trim();
  if (Array.isArray(extra.tags) && extra.tags.length) row.tags = extra.tags.filter((t) => String(t || "").trim());
  row.doc_date = extra.date || todayDash();
  const p = parsed || {};
  if (p.baiduUrl) row.url_baidu = String(p.baiduUrl).trim();
  if (p.quarkUrl) row.url_quark = String(p.quarkUrl).trim();
  if (p.xunleiUrl) row.url_xunlei = String(p.xunleiUrl).trim();
  // 只回传云库认识的键，避免把内部字段带进 p_row
  const out = {};
  for (const k of ROW_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

module.exports = {
  EP, ORIGIN, PK, ADMIN_EMAIL,
  ERR_NO_PASSWORD,
  THUMB_SIDE, FULL_SIDE,
  ROW_KEYS,
  hasCredentials,
  resolvePassword,
  todayDash,
  normName,
  getToken,
  invalidateToken,
  findDup,
  insert,
  setCover,
  toDataUri,
  buildRow,
  _httpJson: httpJson,
  _callAuthed: callAuthed,
};
