// ── AI 集成（bl CLI）──
// 关键修复：原先用 execSync（同步阻塞）调用 bl，单次最长 60s+45s，
// 期间 Node 事件循环被卡死，/api/ready 无法响应 → 控制面板看门狗连续
// 3 次健康检查失败(~15-24s) → taskkill 掉 node → SSE 流断裂 = 用户看到的「流程卡住」。
// 后改为非阻塞 + 超时；并进一步改为 spawn 数组传参(shell:false)——
// 用户粘贴的游戏名/网盘链接不再拼进 shell 命令字符串，消除命令注入且特殊字符不再导致调用失败。
const { spawn } = require("child_process");
const path = require("path");
const { INTRO_BLACKLIST, isBadIntro, isBadSize } = require("./constants");

// bl CLI 调用方式解析：
// 打包/开发态 BL_BIN_PATH 指向 resources/bin/bl.cmd，内部用 resources/node/node.exe 跑
// node_modules/bailian-cli/dist/bailian.mjs。为彻底避免把用户输入拼进 shell，这里拆出
// node + mjs 入口，用 spawn 数组传参(shell:false) 调用（无 shell 解析 → 无注入）。
// 仅当 BL_BIN_PATH 是裸 "bl"(独立运行且走全局安装)时回退 shell:true（自机自用，风险可控）。
let _blSpawn = null;
function resolveBlSpawn() {
  if (_blSpawn) return _blSpawn;
  const bin = process.env.BL_BIN_PATH || "bl";
  if (/\.cmd$/i.test(bin)) {
    const dir = path.dirname(bin);
    const nodeExe = path.join(dir, "..", "node", "node.exe");
    const mjs = path.join(dir, "node_modules", "bailian-cli", "dist", "bailian.mjs");
    _blSpawn = { command: nodeExe, argsPrefix: [mjs], shell: false };
  } else if (/\.(mjs|js)$/i.test(bin)) {
    _blSpawn = { command: process.execPath, argsPrefix: [bin], shell: false };
  } else {
    _blSpawn = { command: bin, argsPrefix: [], shell: true };
  }
  return _blSpawn;
}

// 用 spawn 数组传参(shell:false) 调用 bl，杜绝命令注入。
// subArgs: bl 子命令参数数组（如 ["text","chat","--message", prompt, ...]）；
// 实际执行的命令 = [nodeExe, mjs, ...subArgs]（打包/开发态）或 [bl, ...subArgs]（独立态 shell）。
function runCmd(subArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeout || 60000;
    const { command, argsPrefix, shell } = resolveBlSpawn();
    const argv = [...argsPrefix, ...subArgs];
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, argv, {
      windowsHide: true,
      shell: !!shell,
      env: process.env,
    });
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch (_) { /* 已退出 */ }
      reject(new Error("bl 调用超时（" + Math.round(timeoutMs / 1000) + "s），已终止"));
    }, timeoutMs);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || ("bl 进程退出码 " + code)).trim()));
    });
  });
}

/** 检测 bl CLI 是否可用 */
async function checkBlAvailable() {
  try { await runCmd(["--version"], { timeout: 3000 }); return true; }
  catch { return false; }
}


/**
 * 构建简介 prompt（只做介绍+可选大小）。
 * 封面已拆分到 aiCoverSearch、大小抓取已拆分到夸克接口，避免一次塞三件事互相稀释质量。
 */
function buildPrompt(gameName, opts = {}) {
  let prompt = `请完成以下任务。用户已提供该游戏的网盘资源，因此该游戏必然真实存在，请直接客观描述，不要质疑、不要写免责声明。\n`;
  prompt += `1. 联网搜索游戏"${gameName}"（英文原名：${opts.englishName || "无"}）的客观公开资料，用50-80字中文介绍其开发商/发行商、游戏类型与核心玩法。严禁返回"疑似虚构""无法确认""经核实无真实公开资料""请勿轻信""非官方渠道"等免责声明，否则视为错误输出。\n`;
  prompt += `2. 若你了解该游戏安装包大致大小（如"30.7G"）请一并给出，不确定则写"未抓取到"（不要尝试打开网盘链接读取，以你的已知公开信息为准）。\n`;
  prompt += `严格按以下格式单行输出，不要多余内容：\n介绍：<50-80字真实介绍>\n大小：<如 30.7G，未抓取到则写"未抓取到">`;
  return prompt;
}

/** 解析 bl 一次输出的纯函数（可单测）。返回解析结果与质量标志。封面/大小已拆分，这里只处理介绍+大小文本。 */
function parseSingle(content, { gameName, rawLine, opts = {} } = {}) {
  const introM = content.match(/介绍[:：]\s*([^\n]*)/);
  const sizeM = content.match(/大小[:：][ \t]*([^\n]*)/);
  let intro = (introM?.[1] || "").replace(/[\n\r]+/g, " ").trim().slice(0, 200);
  if (isBadIntro(intro)) intro = "";
  const rawSize = (sizeM?.[1] || "").trim();
  let size = isBadSize(rawSize) ? "" : rawSize;
  return {
    intro, size,
    badIntro: isBadIntro(intro),
    badSize: isBadSize(size) && !!(opts.quarkUrl || opts.baiduUrl || opts.xunleiUrl),
  };
}

function extractContent(out) {
  const m = out.match(/\{[\s\S]*\}/);
  let content = "";
  if (m) {
    try { content = JSON.parse(m[0]).choices?.[0]?.message?.content || ""; } catch { /* not json */ }
  }
  if (!content) content = out; // 兼容非 JSON 纯文本输出
  return content;
}

/** 用 bl 生成游戏介绍（封面已拆分到 aiCoverSearch，大小抓取已拆分到夸克接口，避免任务互相稀释） */
async function aiDescribe(gameName, rawLine, opts = {}) {
  const run = opts.runCmd || runCmd;
  try {
    const out = await run([
      "text", "chat",
      "--message", buildPrompt(gameName, opts),
      "--max-tokens", "600",
      "--output", "json",
    ], { timeout: 60000 });
    const content = extractContent(out);
    const r1 = parseSingle(content, { gameName, rawLine, opts });
    let { intro, size } = r1;

    // 强制重试：首次介绍不合格时，单独再追一次（封面/大小已走独立路径，这里只补介绍；若首次没拿到大小则一并采用二次的大小）
    if (r1.badIntro) {
      const retryPrompt = `请为游戏"${gameName}"（英文：${opts.englishName || "无"}）联网搜索其开发商/类型/核心玩法，输出50-80字中文客观介绍，不要编造、不要写免责声明。严格按格式输出：\n介绍：<客观介绍>`;
      try {
        const out2 = await run([
          "text", "chat",
          "--message", retryPrompt,
          "--max-tokens", "600",
          "--output", "json",
        ], { timeout: 45000 });
        const r2 = parseSingle(extractContent(out2), { gameName, rawLine, opts });
        if (!r2.badIntro) {
          intro = r2.intro;
          if (!r1.size && r2.size) size = r2.size; // 首次未拿到大小则采用二次
        }
      } catch { /* 忽略二次失败 */ }
    }

    // 最终保底：若仍无介绍，用原始文本兜底（至少不是免责声明）
    if (!intro) intro = rawLine;
    return { intro, size, coverUrl: "" };
  } catch { return { intro: rawLine || "", size: "", coverUrl: "" }; }
}

/**
 * 联网搜索游戏封面真实直链：中英文名各搜一次，返回第一个可提取的图片 URL。
 * 不做下载校验（由调用方 downloadCoverFromUrl 用 HTTP 200 + Content-Type 图片校验，防破图）。
 * @returns {Promise<string>} 图片 URL，未搜到返回 ""
 */
async function aiCoverSearch(gameName, englishName, opts = {}) {
  const run = opts.runCmd || runCmd;
  const names = [gameName, englishName].filter(Boolean);
  for (const name of names) {
    const prompt = `联网搜索游戏"${name}"的官方封面或宣传图直链（可直接下载的图片 URL，必须以 .jpg/.jpeg/.png/.webp 结尾）。只返回图片 URL 本身，不要任何解释文字、不要 Markdown 代码块。`;
    try {
      const out = await run(["text", "chat", "--message", prompt, "--max-tokens", "200", "--output", "json"], { timeout: 45000 });
      const content = extractContent(out);
      const m = content.match(/https?:\/\/[^\s）)]+\.(?:jpg|jpeg|png|webp)/i);
      if (m) return m[0];
    } catch { /* 该名称搜索失败，尝试下一个 */ }
  }
  return "";
}

module.exports = {
  checkBlAvailable, aiDescribe, aiCoverSearch, parseSingle, buildPrompt,
  INTRO_BLACKLIST, isBadIntro, isBadSize,
};
