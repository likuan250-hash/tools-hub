// 转存编排器：贴链接 → 收进自己网盘 → 下载到本地 → 上传到目标网盘 → 清理
//
// 阶段设计（每步都可在前端看到进度）：
//   1. resolve   解析链接，识别来源网盘
//   2. save      把分享收进自己网盘（站内转存，不落地）
//   3. probe     列出条目，得到真实 size，规划要传哪些
//   4. download  从来源网盘下载到本地中转目录
//   5. upload    上传到目标网盘
//   6. verify    校验大小一致
//   7. cleanup   删本地临时文件（可关闭，留给用户复查）
//
// 为什么必须落地：三家网盘的转存接口都只认自己签发的 token，跨盘在接口层
// 没有入口（实测夸克对百度分享链接直接返回 41006「分享不存在」）。
// 所以「下载到本地再上传」是唯一的通用路径。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const log = require("./logger");
const cb = require("./client-bridge");
const bd = require("./baidu-official");
const qb = require("./quark-bridge");
const share = require("./share");
const creds = require("./creds");
const prefs = require("./prefs");

// ── 任务仓库（内存 + 落盘，重启可恢复列表）──
const tasks = new Map();
let seq = 0;

function newId() {
  seq += 1;
  return `xfer_${Date.now().toString(36)}_${seq}`;
}

function emit(task, phase, message, extra = {}) {
  task.phase = phase;
  task.message = message;
  task.updatedAt = Date.now();
  Object.assign(task, extra);
  if (task.onEvent) {
    try {
      task.onEvent(snapshot(task));
    } catch (_) {}
  }
}

// 高频进度（下载/上传每读一块就回调一次）必须节流，
// 否则一个 10GB 文件会产生几十万次 emit，把日志和前端轮询打爆。
// 策略：按时间（默认 400ms）节流，但阶段切换和状态变更永远立即发。
function makeThrottle(task, intervalMs = 400) {
  let last = 0;
  return (phase, message, extra) => {
    const now = Date.now();
    if (phase === task.phase && now - last < intervalMs) return;
    last = now;
    emit(task, phase, message, extra);
  };
}

/** 接力模式：等客户端把文件下到中转目录（存在且大小一致），超时抛错 */
async function waitForLocalFiles(workDir, items, { timeoutMs = 3600000, intervalMs = 5000, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  const targetOf = (it) => path.join(workDir, String(it.rel || it.name).split("/").join(path.sep));
  for (;;) {
    let done = 0;
    for (const it of items) {
      const p = targetOf(it);
      let ok = false;
      try { const st = fs.statSync(p); ok = !it.size || st.size === it.size; } catch (e) { ok = false; }
      it.localPath = p;
      it.downloaded = ok ? (it.size || 0) : 0;
      if (ok) { it.status = "downloaded"; done += 1; }
    }
    if (done === items.length) return { done, total: items.length };
    if (Date.now() > deadline) throw new Error("等待客户端下载超时（" + Math.round(timeoutMs / 60000) + " 分钟）：已就绪 " + done + "/" + items.length);
    if (onTick) onTick(done, items.length);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 并发池：limit 路并行跑 fn(item, index)（网盘侧并发过高会被限速/风控，默认取 3） */
async function pMap(items, limit, fn) {
  const n = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  let cursor = 0;
  const workers = new Array(n).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
function snapshot(t) {
  return {
    id: t.id,
    srcProvider: t.srcProvider,
    dstProvider: t.dstProvider,
    link: t.link,
    phase: t.phase,
    status: t.status,
    message: t.message,
    items: t.items,
    totalBytes: t.totalBytes,
    doneBytes: t.doneBytes,
    currentFile: t.currentFile,
    currentPercent: t.currentPercent,
    currentDone: t.currentDone,
    currentTotal: t.currentTotal,
    results: t.results,
    error: t.error,
    startedAt: t.startedAt,
    updatedAt: t.updatedAt,
    keepLocal: t.keepLocal,
    localDir: t.localDir,
    rootName: t.rootName || "",
  };
}

// 中转根目录：优先级 用户持久化设置 > 环境变量(XFER_TMP_DIR/TOOLSHUB_XFER_DIR) > 默认 E 盘机械盘
// 用户可在界面「选择目录」改成任意本地路径，存进 prefs.json 后这里优先采用。
function transferRoot() {
  const saved = prefs.getTmpDir();
  if (saved && saved.userSet && saved.path) return saved.path;
  if (process.env.XFER_TMP_DIR) return process.env.XFER_TMP_DIR;
  return "E:\\网盘中转";
}

function safeName(s) {
  return String(s || "unnamed")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 120);
}

// ── 单条任务执行 ──
async function runTask(task) {
  const tmpRoot = transferRoot();
  const workDir = path.join(tmpRoot, task.id);
  task.localDir = workDir;
  fs.mkdirSync(workDir, { recursive: true });

  try {
    task.status = "running";
    emit(task, "resolve", "正在解析链接…");
    // progress 用于高频回调（下载/上传分块），按时间节流；emit 仍用于阶段切换
    const progress = makeThrottle(task);

    const src = share.detectProvider(task.link);
    if (!src) throw new Error("无法识别的分享链接（支持百度网盘 / 夸克网盘）");
    if (src === "xunlei") throw new Error("迅雷暂不支持（无官方开放平台，本版本不做）");
    task.srcProvider = src;
    task.pwd = share.extractPwd(task.link);

    // ── 阶段 2：收进自己网盘 ──
    emit(task, "save", `正在把分享收进${src === "baidu" ? "百度" : "夸克"}网盘的「中转文件夹」…`);
    let entries = [];
    if (src === "baidu") {
      entries = await share.baiduSaveShare(task.link, "/百度中转文件夹");
    } else {
      const r = await share.quarkSaveShare(task.link);
      entries = r.items;
    }
    if (!entries.length) throw new Error("转存后没有找到任何文件");

    task.items = entries.map((e) => ({
      name: e.server_filename || e.file_name || e.filename,
      size: e.size || 0,
      isDir: src === "baidu" ? e.isdir === 1 : !!e.dir,
      srcId: src === "baidu" ? e.fs_id : e.fid,
      status: "pending",
    }));

    // ⚠ 夸克有两套 fid，互不通用（实测 2026-09-18）：
    //   netdisk-hub 返回短格式 `42924899aa8e44ee88b757f853cf4559`（转存/分享接口用）
    //   官方 Skill  需要长格式 `~1i0i4idhq...|u5NzdrBtEwA`（download/upload 用）
    //   转存链路上游给的是短 fid，下载前必须换成 Skill 的长 fid，否则报「文件找不到」。
    if (src === "quark") {
      emit(task, "probe", "正在对齐夸克文件标识…");
      for (const it of task.items) {
        if (it.isDir) continue;
        try {
          const longFid = await qb.findFile(it.name, "0");
          if (longFid) {
            it.apiFid = it.srcId; // 短 fid，留给分享/列表类接口
            it.srcId = longFid; // 长 fid，供 download 使用
          } else {
            log.warn(`夸克未找到同名文件，沿用短 fid: ${it.name}`);
          }
        } catch (e) {
          log.warn(`夸克 fid 转换失败 ${it.name}: ${e.message}`);
        }
      }
    }

    // 顶层文件夹：分享若是「单个文件夹」，它就是本次转存的根 —— 下载和上传都原样保留它
    const dirCount = task.items.filter((x) => x.isDir).length;
    task.rootName = task.items.length === 1 && dirCount === 1 ? safeName(task.items[0].name) : "";
    if (task.rootName) emit(task, "probe", `顶层文件夹：${task.rootName}（下载/上传都会保留）`);

    // 展开目录（递归，保留相对路径 it.rel）：百度/夸克都把目录当成一个条目
    const flat = [];
    for (const it of task.items) {
      if (it.isDir) {
        emit(task, "probe", `展开目录 ${it.name}…`);
        const prefix = task.rootName ? safeName(it.name) : "";
        flat.push(...(await listRecursive(src, it, prefix)));
      } else {
        flat.push(Object.assign({}, it, { rel: safeName(it.name) }));
      }
    }
    task.items = flat;
    task.totalBytes = flat.reduce((s, x) => s + (x.size || 0), 0);
    emit(task, "probe", `共 ${flat.length} 个文件，${fmtSize(task.totalBytes)}`);

    if (!flat.length) throw new Error("分享里没有可下载的文件（只有空目录）");

    // ── 阶段 4：下载 ──
    if (task.downloadMode === "client") {
      // 官方客户端接力：客户端吃 P2P/专属节点，我们只做"唤起 + 监控 + 接管上传"
      const r = cb.launch(src, task.link, { dryRun: false, onLog: (m) => log.info(m) });
      if (!r.ok) throw new Error(`唤起${src === "baidu" ? "百度" : "夸克"}客户端失败：${r.reason}`);
      emit(task, "download", `已唤起客户端：请在客户端里把「${task.rootName || "中转文件夹"}」下载到中转目录，脚本会自动接管上传…`);
      await waitForLocalFiles(workDir, task.items, {
        timeoutMs: Number(process.env.XFER_CLIENT_TIMEOUT_MS || 60 * 60 * 1000),
        intervalMs: 5000,
        onTick: (done, total) => emit(task, "download", `等待客户端下载：${done}/${total} 个文件就绪`),
      });
      task.doneBytesBase = task.items.reduce((s, x) => s + (x.downloaded || 0), 0);
      task.doneBytes = task.doneBytesBase;
      emit(task, "download", "本地文件已齐，开始接管上传");
    } else {
    emit(task, "download", "开始下载到本地中转目录…");
    const dlConc = Math.max(1, Number(process.env.XFER_DL_CONCURRENCY || 3));
    // 并发下载（默认 3 路）：单流串行跑不满带宽，多文件并行才接近客户端速度
    await pMap(task.items, dlConc, async (it) => {
      task.currentFile = it.name;
      emit(task, "download", `下载 ${it.name} (${fmtSize(it.size)})`, { currentFile: it.name });

      // 本地落盘保留整棵目录（含顶层文件夹）：workDir/<rel>
      const relNative = String(it.rel || it.name).split("/").join(path.sep);
      const localTarget = path.join(workDir, relNative);
      fs.mkdirSync(path.dirname(localTarget), { recursive: true });
      let saved;
      if (src === "baidu") {
        const size = it.size || 0;
        saved = await bd.download(it.srcId, localTarget, (p) => {
          it.percent = p.percent;
          task.doneBytes = (task.doneBytesBase || 0) + p.got;
          progress("download", `下载 ${it.name} ${(p.percent * 100).toFixed(0)}%`, {
            currentFile: it.name,
            currentPercent: p.percent,
            currentDone: p.got,
            currentTotal: size,
          });
        });
      } else {
        saved = await qb.download(it.srcId, path.dirname(localTarget));
      }
      it.localPath = saved.path || localTarget;
      it.downloaded = fs.existsSync(it.localPath) ? fs.statSync(it.localPath).size : 0;
      it.status = "downloaded";
      task.doneBytesBase = (task.doneBytesBase || 0) + (it.downloaded || 0);
      task.doneBytes = task.doneBytesBase;
      if (it.size && it.downloaded !== it.size) {
        log.warn(`大小不符 ${it.name}: 期望${it.size} 实得${it.downloaded}`);
      }
    });
    emit(task, "download", "下载完成");
    }

    // ── 阶段 5：上传 ──
    const dst = task.dstProvider;
    emit(task, "upload", `开始上传到${dst === "baidu" ? "百度" : "夸克"}…`);
    const upDir = await ensureRemoteDir(dst, task.dstPath);
    // rel → 目标网盘上的远端目录 fid/路径（含顶层文件夹），按需逐级建目录
    const remoteDirCache = new Map();
    const remoteDirFor = async (relDir) => {
      const segs = String(relDir || "").split("/").filter(Boolean).map(safeName);
      const key = segs.join("/");
      if (remoteDirCache.has(key)) return remoteDirCache.get(key);
      let parent = dst === "baidu" ? task.dstPath : upDir;
      let parentFid = upDir;
      for (const seg of segs) {
        if (dst === "baidu") {
          parent = parent + "/" + seg;
          await bd.ensureDir(parent);
          parentFid = parent;
        } else {
          parentFid = await qb.ensureFolder(seg, parentFid);
        }
      }
      const val = dst === "baidu" ? { path: parent, fid: parentFid } : parentFid;
      remoteDirCache.set(key, val);
      return val;
    };

    let upBase = 0;
    const upConc = Math.max(1, Number(process.env.XFER_UP_CONCURRENCY || 3));
    // 并发上传（默认 3 路）；并发过高会被网盘限速/风控，可用环境变量下调
    await pMap(task.items, upConc, async (it) => {
      emit(task, "upload", `上传 ${it.name}`, { currentFile: it.name });
      const relDir = String(it.rel || it.name).split("/").slice(0, -1).join("/");
      const dest = await remoteDirFor(relDir);
      if (dst === "baidu") {
        const remote = `${dest.path}/${safeName(it.name)}`;
        const r = await bd.upload(it.localPath, remote, (p) => {
          if (p.phase === "upload" && p.total) {
            const frac = (p.got || 0) / p.total;
            it.percent = frac;
            task.doneBytes = upBase + (it.downloaded || 0) * frac;
            progress("upload", `上传 ${it.name} ${(frac * 100).toFixed(0)}%`, {
              currentFile: it.name,
              currentPercent: frac,
            });
          }
        });
        it.remoteFsId = r.fsId;
        it.instant = r.instant;
      } else {
        const r = await qb.upload(it.localPath, dest);
        it.remoteFsId = (r.ids || [])[0];
        it.instant = r.instant;
      }
      it.status = "uploaded";
      upBase += it.downloaded || 0;
      task.doneBytes = upBase;
    });
    emit(task, "upload", "上传完成");

    // ── 阶段 6：校验 ──
    emit(task, "verify", "正在校验远端文件…");
    // 上传保留了目录结构 → 校验要按每个文件所在的远端目录分别列表
    const verifyDirCache = new Map();
    const remoteIn = async (relDir) => {
      const key = String(relDir || "");
      if (!verifyDirCache.has(key)) {
        const remotePath = task.dstPath + (key ? "/" + key : "");
        verifyDirCache.set(key, await listRemote(dst, remotePath).catch(() => []));
      }
      return verifyDirCache.get(key);
    };
    let okCount = 0;
    for (const it of task.items) {
      const relDir = String(it.rel || it.name).split("/").slice(0, -1).join("/");
      const remoteItems = await remoteIn(relDir);
      const hit = remoteItems.find((r) => (r.name || "") === it.name);
      if (
        hit &&
        (!it.downloaded || !hit.size || Number(hit.size) === it.downloaded || it.instant)
      ) {
        it.verify = "ok";
        okCount++;
      } else if (hit) {
        it.verify = "size-mismatch";
        it.remoteSize = hit.size;
      } else {
        it.verify = "missing";
      }
    }
    task.results = {
      total: task.items.length,
      verified: okCount,
      instant: task.items.filter((x) => x.instant).length,
    };
    emit(task, "verify", `校验完成：${okCount}/${task.items.length} 个文件确认到位`);

    // ── 阶段 7：清理 ──
    if (!task.keepLocal) {
      emit(task, "cleanup", "清理本地临时文件…");
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
        emit(task, "cleanup", "已清理本地中转文件");
      } catch (e) {
        log.warn("清理失败（可手动删）:", workDir, e.message);
      }
    }

    task.status = "done";
    task.phase = "done";
    task.message = `完成：${task.items.length} 个文件已到${dst === "baidu" ? "百度" : "夸克"}`;
    emit(task, "done", task.message);
  } catch (e) {
    task.status = "error";
    task.error = e.message;
    log.error(`任务 ${task.id} 失败:`, e.message);
    emit(task, "error", e.message);
    // 失败时保留现场，方便排查
    log.info("失败现场保留在:", workDir);
  }
}

// 递归列出目录下的文件，**保留相对路径 it.rel**（含顶层文件夹与所有子目录），
// 下载与上传都按这个相对路径落盘/建目录，不再拍平成一层。
async function listRecursive(provider, dirItem, prefix = "") {
  const out = [];
  const joinRel = (a, b) => (a ? a + "/" + safeName(b) : safeName(b));
  if (provider === "baidu") {
    const items = await bd.listDir(dirItem.srcId ? "/" + dirItem.name : "/");
    for (const f of items) {
      const rel = joinRel(prefix, f.server_filename);
      if (f.isdir === 1) {
        out.push(...(await listRecursive(provider, { name: f.server_filename, srcId: f.fs_id, isDir: true }, rel)));
      } else {
        out.push({ name: f.server_filename, rel, size: f.size, isDir: false, srcId: f.fs_id, status: "pending" });
      }
    }
  } else {
    const files = await qb.browse(dirItem.srcId, {});
    for (const f of files) {
      const rel = joinRel(prefix, f.filename);
      if (f.file_type === "0") {
        out.push(...(await listRecursive(provider, { name: f.filename, srcId: f.fid, isDir: true }, rel)));
      } else {
        out.push({ name: f.filename, rel, size: f.size, isDir: false, srcId: f.fid, status: "pending" });
      }
    }
  }
  return out;
}

// 确保远端目标目录存在，返回百度用不上（用路径）/夸克用的 fid
async function ensureRemoteDir(provider, destPath) {
  if (provider === "baidu") {
    await bd.ensureDir(destPath);
    return destPath;
  }
  // 夸克：destPath 形如 /夸克中转文件夹
  const name = destPath.split("/").filter(Boolean).pop() || "夸克中转文件夹";
  return qb.ensureFolder(name);
}

async function listRemote(provider, destPath) {
  if (provider === "baidu") {
    const items = await bd.listDir(destPath);
    return items.map((f) => ({ name: f.server_filename, size: f.size, id: f.fs_id }));
  }
  const name = destPath.split("/").filter(Boolean).pop() || "夸克中转文件夹";
  const fid = await qb.findFolder(name);
  if (!fid) return [];
  const items = await qb.browse(fid, {});
  return items.map((f) => ({ name: f.filename, size: f.size, id: f.fid }));
}

function fmtSize(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 1)} ${u[i]}`;
}

// ── 对外入口 ──
function start({ link, dstProvider, dstPath, keepLocal = false, downloadMode = "builtin", onEvent }) {
  const t = {
    id: newId(),
    link: String(link || "").trim(),
    dstProvider: dstProvider || "quark",
    dstPath: dstPath || (dstProvider === "baidu" ? "/百度中转文件夹" : "/夸克中转文件夹"),
    keepLocal: !!keepLocal,
    downloadMode: String(downloadMode) === "client" ? "client" : "builtin",
    phase: "queued",
    status: "queued",
    message: "排队中",
    items: [],
    results: null,
    doneBytes: 0,
    doneBytesBase: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    onEvent,
  };
  tasks.set(t.id, t);
  // 不 await：立刻返回任务 id，前端轮询进度
  runTask(t).catch((e) => {
    t.status = "error";
    t.error = e.message;
  });
  return snapshot(t);
}

function get(id) {
  const t = tasks.get(id);
  return t ? snapshot(t) : null;
}

function all() {
  return [...tasks.values()].map(snapshot).sort((a, b) => b.startedAt - a.startedAt);
}

module.exports = {start, get, all, fmtSize, transferRoot, waitForLocalFiles };
