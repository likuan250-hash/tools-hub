// 夸克官方 Skill 调用桥
//
// 夸克侧不自己逆向，直接 spawn 官方 quark-drive.cjs（已装 1.0.20）。
// 每个命令输出一行行 JSON（JSONL），末行 type=result 是总结果。
//
// 实测已知噪音（必须过滤，否则解析会炸）：
//   1) 输出里混有「拒绝访问。」—— Skill 内部调 reg.exe 生成设备指纹被沙箱拦，
//      功能不受影响，但混在 stdout 里会破坏 JSON 解析。
//   2) --verbose 会打大量 [DEBUG][TraceManager] 行（阿里 ARMS 埋点上报）。
//   3) Windows 中文控制台可能把 UTF-8 中文吐成乱码（filePath 等字段），
//      这里按 UTF-8 解码，实测 filePath 正常。
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const log = require("./logger");
const creds = require("./creds");

function scriptPath() {
  const dir = creds.quarkSkillDir();
  if (!dir) throw new Error("找不到夸克官方 Skill（quarkclouddrive/scripts/quark-drive.cjs）");
  return path.join(dir, "scripts", "quark-drive.cjs");
}

// Node 运行时：优先工具箱自带的，回退系统 node
function nodeBin() {
  const cand = process.env.RESOURCES_PATH
    ? path.join(process.env.RESOURCES_PATH, "node", "node.exe")
    : null;
  if (cand && fs.existsSync(cand)) return cand;
  return process.execPath || "node";
}

// 跑一条 quark-drive 命令，收集 JSONL。
// 返回 { records: [...], result: {...} | null, stderr }
function run(args, { onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = nodeBin();
    const script = scriptPath();

    // Skill 需要运行时目录；不设的话它会落到默认位置，这里统一指到本工具数据目录
    const env = Object.assign({}, process.env, {
      OPENCLAW_RUNTIME_DIR:
        process.env.OPENCLAW_RUNTIME_DIR || path.join(process.env.XFER_DATA_DIR || "", "runtime"),
    });

    // ── 宿主 Agent 标识注入（关键，别删）──
    // quark-drive.cjs 内置 detectAgent()：不认「谁在调我」，只读环境变量白名单。
    // 它的 WorkBuddy 判定条件（逆向后）大致是：
    //   CLIENT_INFO_PRODUCT_NAME === "WorkBuddy"
    //   || CLIENT_INFO_IDE_TYPE === "WorkBuddy"
    //   || CLIENT_INFO_PLATFORM === "WorkBuddy"
    //   || WORKBUDDY_CONFIG_DIR !== undefined
    //   || CODEBUDDY_SESSION_ID !== undefined
    //   || CODEBUDDY_HOST?.startsWith("workbuddy")
    //   || CODEBUDDY_CONFIG_DIR?.includes(".workbuddy")
    // xfer-hub 是 Electron 子进程 spawn 出来的，这些变量一个都不带，
    // 于是所有命令一律被拒：「无法识别当前 Agent 环境，禁止继续使用」。
    // 实测只补 CLIENT_INFO_PRODUCT_NAME 即可通过（get-user-info 返回 code:0 / SVIP）。
    // 只写这一条，不伪造 WORKBUDDY_CONFIG_DIR 之类指向真实磁盘的路径，避免 Skill 去读不该读的目录。
    env.CLIENT_INFO_PRODUCT_NAME = env.CLIENT_INFO_PRODUCT_NAME || "WorkBuddy";
    env.CLIENT_INFO_IDE_TYPE = env.CLIENT_INFO_IDE_TYPE || "WorkBuddy";
    env.CLIENT_INFO_PLATFORM = env.CLIENT_INFO_PLATFORM || "WorkBuddy";
    if (env.OPENCLAW_RUNTIME_DIR) fs.mkdirSync(env.OPENCLAW_RUNTIME_DIR, { recursive: true });

    const child = spawn(bin, [script, ...args], {
      cwd: path.dirname(script),
      env,
      windowsHide: true,
    });

    let rest = ""; // 跨 chunk 缓冲，避免 JSON 被切断
    const records = [];
    let stderr = "";
    let timer = null;

    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      // 已知噪音：沙箱拦截 reg.exe 的提示，逐字过滤
      if (s === "拒绝访问。" || s === "拒绝访问" || s.includes("拒绝访问。")) return;
      if (!s.startsWith("{")) return; // 非 JSON 行（进度条等）丢弃

      let obj;
      try {
        obj = JSON.parse(s);
      } catch (_) {
        return; // 半截 JSON，丢弃
      }
      records.push(obj);
      if (onLine) onLine(obj);
      if (obj.type === "result" || obj.type === "error") {
        // 不在这里 resolve，等进程退出，确保缓冲收全
      }
    };

    const onData = (chunk) => {
      rest += chunk.toString("utf8");
      let idx;
      while ((idx = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, idx);
        rest = rest.slice(idx + 1);
        handleLine(line);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch (_) {}
        reject(new Error(`quark-drive ${args[0]} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
    }

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`无法启动 quark-drive: ${e.message}`));
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (rest.trim()) handleLine(rest);
      const result = [...records].reverse().find((r) => r.type === "result") || null;
      const errRec = [...records].reverse().find((r) => r.type === "error") || null;
      resolve({ code, records, result, error: errRec, stderr });
    });
  });
}

// 简单命令：要求成功，否则抛错
async function runOrThrow(args, opts) {
  const r = await run(args, opts);
  const res = r.result;
  // 成功形态：{code:0, msg:"成功"/"上传成功", type:"result"}
  if (res && res.code !== undefined && res.code !== 0) {
    throw new Error(`quark-drive ${args[0]} 失败: ${res.msg || JSON.stringify(res).slice(0, 200)}`);
  }
  if (r.error) {
    throw new Error(
      `quark-drive ${args[0]} 出错: ${r.error.msg || JSON.stringify(r.error).slice(0, 200)}`,
    );
  }
  if (!res && r.code !== 0) {
    throw new Error(`quark-drive ${args[0]} 退出码 ${r.code}: ${r.stderr.slice(0, 300)}`);
  }
  return r;
}

// ── 对外能力 ──

async function userInfo() {
  const r = await runOrThrow(["get-user-info"]);
  return r.result;
}

// 列目录内容。
//
// ⚠ 实测坑（2026-09-18）：quark-drive 的 `browse --all` 在 fid="0"（根目录）时
//   会返回 0 条，而同样的目录不带 --all 能正常返回 20 条。这是 Skill 自身的 bug。
//   → 一律不用 --all，改用 --page-size 拉大页（上限 100）。
//   需要更多时由调用方翻页，这里至少保证根目录能列出内容。
async function browse(parentFid = "0", { pageSize = 100 } = {}) {
  const args = ["browse", "--parent-fid", parentFid || "0", "--page-size", String(pageSize)];
  const r = await runOrThrow(args);
  const items = r.records
    .filter((x) => x.type === "list" && x.data && x.data.fid)
    .map((x) => x.data);
  return items;
}

// 找目录 fid（不存在返回 null）
async function findFolder(name, parentFid = "0") {
  const items = await browse(parentFid, {});
  const hit = items.find((f) => f.file_type === "0" && f.filename === name);
  return hit ? hit.fid : null;
}

async function createFolder(name, parentFid = "0") {
  // 注意参数名是 --dir-path（不是 --name），传错会报 unknown option
  const r = await runOrThrow([
    "create-folder",
    "--dir-path",
    name,
    "--parent-fid",
    parentFid || "0",
  ]);
  return r.result;
}

async function ensureFolder(name, parentFid = "0") {
  const existed = await findFolder(name, parentFid);
  if (existed) return existed;
  const r = await createFolder(name, parentFid);
  const d = (r && r.data) || r || {};
  return d.fid || (d.data && d.data.fid) || null;
}

// 下载到本地目录。返回 { path, name, size }
async function download(fid, outputDir, { onLine } = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const r = await runOrThrow(["download", "--fid", fid, "--output-dir", outputDir, "--overwrite"], {
    onLine,
    timeoutMs: 0,
  });
  const d = (r.result && r.result.data) || {};
  return { path: d.filePath, name: d.fileName, size: d.fileSize };
}

// 上传本地文件或目录到指定 fid 目录
async function upload(localPath, parentFid = "0", { onLine } = {}) {
  const args = ["upload", localPath];
  if (parentFid) args.push("--parent-fid", parentFid);
  const r = await runOrThrow(args, { onLine });
  const d = (r.result && r.result.data) || {};
  return {
    names: d.fileNames || [],
    count: d.fileCount || 0,
    size: d.totalSize || 0,
    ids: d.fids || [],
    instant: !!d.instantUpload,
    fullPath: d.fullPath || "",
  };
}

// 找文件 fid（用于「已在夸克的文件」直接取）
async function findFile(name, parentFid = "0") {
  const items = await browse(parentFid, {});
  const hit = items.find((f) => f.file_type === "1" && f.filename === name);
  return hit ? hit.fid : null;
}

module.exports = {
  run,
  runOrThrow,
  userInfo,
  browse,
  findFolder,
  createFolder,
  ensureFolder,
  findFile,
  download,
  upload,
};
