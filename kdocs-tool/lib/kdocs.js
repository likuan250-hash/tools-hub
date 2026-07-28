// ── kdocs-cli 操作封装（使用 spawn 避免 shell 引号问题）──
// 关键修复：原先用 spawnSync（同步阻塞），长耗时(如大封面上传)会卡死事件循环，
// 导致 /api/ready 无响应 → 看门狗误杀 node → 流程卡住。改为非阻塞 spawn + 超时。
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { FILE_ID, WORK_DIR } = require("./config");

// 优先使用项目自带的二进制（kdocs-cli-bin/kdocs-cli.exe），否则回退到全局 PATH 的 kdocs-cli
const LOCAL_CLI = path.join(__dirname, "..", "kdocs-cli-bin", "kdocs-cli.exe");
const KDOCS_CLI = fs.existsSync(LOCAL_CLI) ? LOCAL_CLI : "kdocs-cli";

// Windows 命令行长度上限约 32767 字符；带 base64 的 upload_attachment 远超此限，
// 直接塞 --args 会触发 ENAMETOOLONG。超过阈值改用 --file 从临时 JSON 读入，彻底规避。
const ARGS_LENGTH_LIMIT = 30000;

/** 调用 kdocs-cli 的 API 工具（非阻塞，30s 超时） */
function callMcporter(functionName, jsonParams) {
  const fullParams = { file_id: FILE_ID, ...jsonParams };
  const jsonStr = JSON.stringify(fullParams);
  let tmpFile = null;
  let cliArgs;
  if (jsonStr.length > ARGS_LENGTH_LIMIT) {
    // 大参数（如封面 base64）：写临时文件后用 --file 传入
    tmpFile = path.join(os.tmpdir(), `kdocs-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, jsonStr, "utf8");
    cliArgs = ["call", functionName, "--file", tmpFile];
  } else {
    cliArgs = ["call", functionName, "--args", jsonStr];
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(KDOCS_CLI, cliArgs, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.setEncoding("utf-8").on("data", (d) => (stdout += d));
    if (child.stderr) child.stderr.setEncoding("utf-8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch (_) { /* 已退出 */ }
      reject(new Error("kdocs-cli 调用超时（30s），已终止"));
    }, 30000);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdout || stderr || "";
      const m = out.match(/\{[\s\S]*\}/);
      try { resolve(m ? JSON.parse(m[0]) : { raw: out.trim() }); }
      catch (_) { resolve({ raw: out.trim() }); }
    });
  }).finally(() => {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) { /* 忽略清理失败 */ } }
  });
}

/** 检测 kdocs-cli 是否已配置（验证 token 有效性） */
function checkKdocsReady() {
  return new Promise((resolve) => {
    const child = spawn(KDOCS_CLI, ["auth", "status"], { windowsHide: true });
    let stdout = "";
    if (child.stdout) child.stdout.setEncoding("utf-8").on("data", (d) => (stdout += d));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch (_) { /* 已退出 */ }
      resolve(false);
    }, 5000);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const m = stdout.match(/\{[\s\S]*\}/);
      if (m) {
        try { resolve(JSON.parse(m[0]).authenticated === true); return; } catch (_) { /* 解析失败当未配置 */ }
      }
      resolve(false);
    });
  });
}

/** 读取文件 Base64 */
function fileBase64(fp) { return fs.readFileSync(fp).toString("base64"); }

module.exports = { callMcporter, checkKdocsReady, fileBase64 };
