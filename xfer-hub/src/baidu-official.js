// 百度网盘开放平台 API 封装（xpan）
//
// 与 netdisk-hub/src/baidu.js 的本质区别：
//   netdisk-hub 走的是「网页端逆向」（BDUSS cookie + /share/transfer），只做站内转存，不落地。
//   本模块走「开放平台」（OAuth access_token + xpan/rest/2.0），做真正的下载与上传。
//
// 凭证：由 creds.baiduToken() 提供（只读复用 netdisk-hub 的 store.json，scope=basic netdisk）。
//
// 全部接口均经 2026-09-18 实测：
//   [OK] uinfo                用户信息
//   [OK] file?method=list     列目录
//   [OK] multimedia?filemetas 取下载直链 dlink
//   [OK] dlink + UA下载       162690B 字节一致
//   [OK] precreate            预创建（含秒传判定）
//   [OK] superfile2           分片上传（4MB/片）
//   [OK] file?method=create   合并落盘，回读字节一致
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const log = require("./logger");
const creds = require("./creds");

const XPAN = "https://pan.baidu.com/rest/2.0/xpan";
const PCS = "https://d.pcs.baidu.com/rest/2.0/pcs";
const BLOCK = 4 * 1024 * 1024; // 百度固定分片 4MB
// 百度要求：取 dlink 与下载都必须带这个 UA，否则 403
const UA = "pan.baidu.com";

let _token = null;
function token() {
  if (!_token) _token = creds.baiduToken().token;
  return _token;
}

function api(url, params = {}, init = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", token());
  return fetch(u, init);
}

async function jsonOrThrow(res, what) {
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    throw new Error(`${what} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (j.errno !== undefined && j.errno !== 0) {
    throw new Error(`${what} 失败 errno=${j.errno} ${j.errmsg || ""}`);
  }
  return j;
}

// ── 基础信息 ──
async function uinfo() {
  const r = await api(`${XPAN}/nas`, { method: "uinfo" });
  return jsonOrThrow(r, "uinfo");
}

async function listDir(dir = "/", limit = 1000) {
  const all = [];
  let start = 0;
  for (;;) {
    const r = await api(`${XPAN}/file`, {
      method: "list",
      dir,
      order: "name",
      limit: String(limit),
      start: String(start),
    });
    const j = await jsonOrThrow(r, `list ${dir}`);
    const batch = j.list || [];
    all.push(...batch);
    if (batch.length < limit) break;
    start += limit;
    if (start > 20000) break; // 防御性上限
  }
  return all;
}

// 找目录 fid（不存在返回 null）。百度用 path 操作，fid 用途有限，这里主要做存在性检查。
async function findDir(dirPath) {
  const parent = path.posix.dirname(dirPath);
  const name = path.posix.basename(dirPath);
  try {
    const items = await listDir(parent === "." ? "/" : parent);
    const hit = items.find((f) => f.isdir === 1 && f.server_filename === name);
    return hit ? hit.fs_id : null;
  } catch (e) {
    log.warn("findDir 失败:", dirPath, e.message);
    return null;
  }
}

// 确保远端目录存在（逐级创建）
async function ensureDir(dirPath) {
  if (!dirPath || dirPath === "/") return true;
  const parts = dirPath.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    const parent = cur || "/";
    cur = cur + "/" + p;
    const existed = await findDir(cur);
    if (existed) continue;
    const r = await api(
      `${XPAN}/file`,
      { method: "create" },
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ path: cur, isdir: "1", block_list: "[]" }),
      },
    );
    const j = await jsonOrThrow(r, `create dir ${cur}`);
    log.info("已创建远端目录:", cur, "fs_id=", j.fs_id);
  }
  return true;
}

// ── 下载 ──
// 取文件直链。支持批量（fsids 数组）。
async function fileMetas(fsIds) {
  const ids = Array.isArray(fsIds) ? fsIds : [fsIds];
  const r = await api(`${XPAN}/multimedia`, {
    method: "filemetas",
    fsids: JSON.stringify(ids),
    dlink: "1",
  });
  const j = await jsonOrThrow(r, "filemetas");
  return j.list || [];
}

// 流式下载到本地文件，带进度回调。
// 注意：dlink 已含签名，追加 access_token 即可直接用（实测通过）。
async function download(fsId, savePath, onProgress) {
  const [info] = await fileMetas(fsId);
  if (!info) throw new Error(`取不到 fs_id=${fsId} 的文件信息`);
  if (!info.dlink) throw new Error(`文件 ${info.filename} 无下载直链（可能是文件夹）`);

  const u = new URL(info.dlink);
  u.searchParams.set("access_token", token());

  const r = await fetch(u, {
    headers: { "User-Agent": UA, Referer: "https://pan.baidu.com/" },
    redirect: "follow",
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`下载失败 HTTP ${r.status} ${body.slice(0, 200)}`);
  }

  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  const total = Number(info.size) || 0;
  let got = 0;
  const tmp = savePath + ".part";

  const nodeStream = Readable.fromWeb(r.body);
  nodeStream.on("data", (c) => {
    got += c.length;
    if (onProgress) onProgress({ got, total, percent: total ? got / total : 0 });
  });

  await pipeline(nodeStream, fs.createWriteStream(tmp));
  // 校验：大小必须与云端一致
  const st = fs.statSync(tmp);
  if (total && st.size !== total) {
    fs.unlinkSync(tmp);
    throw new Error(`下载大小不符：期望 ${total} 实得 ${st.size}`);
  }
  fs.renameSync(tmp, savePath);
  log.info(`下载完成 ${info.filename} ${st.size}B`);
  return { path: savePath, size: st.size, name: info.filename, md5: info.md5 };
}

// ── 上传 ──
const md5hex = (buf) => crypto.createHash("md5").update(buf).digest("hex");

// 分片上传单个文件。
// 百度语义（实测确认，容易搞反）：
//   precreate.return_type = 1 → 有新分片要传（uploadid 有效，继续）
//   precreate.return_type = 2 → 全部分片秒传命中，无需上传
async function upload(localPath, remotePath, onProgress) {
  const stat = fs.statSync(localPath);
  const size = stat.size;
  const name = path.basename(localPath);

  // 分片并算 md5（大文件用流式，避免一次性读入内存）
  const parts = [];
  const fd = fs.openSync(localPath, "r");
  try {
    for (let off = 0; off < size; off += BLOCK) {
      const len = Math.min(BLOCK, size - off);
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, off);
      parts.push({ offset: off, length: len, md5: md5hex(buf) });
      if (onProgress) onProgress({ phase: "hash", got: off + len, total: size });
    }
  } finally {
    fs.closeSync(fd);
  }

  // ① 预创建
  const r1 = await api(
    `${XPAN}/file`,
    { method: "precreate" },
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        path: remotePath,
        size: String(size),
        isdir: "0",
        autoinit: "1",
        block_list: JSON.stringify(parts.map((p) => p.md5)),
        rtype: "3", // 3 = 覆盖同名
      }),
    },
  );
  const j1 = await jsonOrThrow(r1, "precreate");

  if (j1.return_type === 2) {
    log.info(`秒传命中（全部分片已存云端）: ${name}`);
    return { fsId: j1.fs_id, size, instant: true, name };
  }
  if (!j1.uploadid) throw new Error("precreate 未返回 uploadid");

  // ② 逐片上传（已存在云端的分片可跳过——这里按顺序全传，百度会自动识别）
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const url =
      `${PCS}/superfile2?method=upload&access_token=${token()}` +
      `&type=tmpfile&path=${encodeURIComponent(remotePath)}` +
      `&uploadid=${encodeURIComponent(j1.uploadid)}&partseq=${i}`;

    const chunk = fs.readFileSync(localPath, { start: 0 }).subarray(p.offset, p.offset + p.length);
    const form = new FormData();
    form.append("file", new Blob([chunk]), `part${i}`);

    const r2 = await fetch(url, { method: "POST", body: form });
    const text = await r2.text();
    let j2;
    try {
      j2 = JSON.parse(text);
    } catch (_) {
      throw new Error(`superfile2 part${i} 返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (j2.error_code) throw new Error(`superfile2 part${i} 失败: ${JSON.stringify(j2)}`);
    if (onProgress) {
      onProgress({ phase: "upload", got: i + 1, total: parts.length, part: i });
    }
  }

  // ③ 合并
  const r3 = await api(
    `${XPAN}/file`,
    { method: "create" },
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        path: remotePath,
        size: String(size),
        isdir: "0",
        block_list: JSON.stringify(parts.map((p) => p.md5)),
        uploadid: j1.uploadid,
        rtype: "3",
      }),
    },
  );
  const j3 = await jsonOrThrow(r3, "create");
  log.info(`上传完成 ${name} ${size}B fs_id=${j3.fs_id}`);
  return { fsId: j3.fs_id, size, instant: false, name };
}

// 上传一个本地目录（递归），保持相对结构
async function uploadDir(localDir, remoteDir, onProgress, onFile) {
  const results = [];
  const walk = async (base, rel) => {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      const lp = path.join(base, e.name);
      const rp = remoteDir + "/" + (rel ? rel + "/" : "") + e.name;
      if (e.isDirectory()) {
        await ensureDir(rp);
        await walk(lp, (rel ? rel + "/" : "") + e.name);
      } else {
        const r = await upload(lp, rp, onProgress);
        results.push(r);
        if (onFile) onFile(r);
      }
    }
  };
  await walk(localDir, "");
  return results;
}

// ── 站内转存（用于把别人的分享先收进自己网盘）──
// 注意：开放平台 xpan 不提供 share 转存接口（仅网页端有）。
// 所以「分享链接 → 自己网盘」这一步仍复用 netdisk-hub 的逆向实现，见 share.js。

module.exports = {
  uinfo,
  listDir,
  findDir,
  ensureDir,
  fileMetas,
  download,
  upload,
  uploadDir,
  BLOCK,
};
