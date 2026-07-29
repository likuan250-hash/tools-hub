// ── AI 集成（bl CLI）──
// 关键修复：原先用 execSync（同步阻塞）调用 bl，单次最长 60s+45s，
// 期间 Node 事件循环被卡死，/api/ready 无法响应 → 控制面板看门狗连续
// 3 次健康检查失败(~15-24s) → taskkill 掉 node → SSE 流断裂 = 用户看到的「流程卡住」。
// 后改为非阻塞 + 超时；并进一步改为 spawn 数组传参(shell:false)——
// 用户粘贴的游戏名/网盘链接不再拼进 shell 命令字符串，消除命令注入且特殊字符不再导致调用失败。
const { spawn } = require("child_process");
const path = require("path");

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

// 免责声明黑名单：bl 可能把"严禁编造"理解成"查不到就说虚构"
const INTRO_BLACKLIST = /疑似虚构|无法确认|经核实无真实|请勿轻信|非官方渠道|暂无公开资料|无法核实|没有公开资料|不存在|误传|虚构/gi;
const SIZE_EMPTY = /^(无|未知|none|null|未抓取到)?$/i;

function isBadIntro(s) { return !s || INTRO_BLACKLIST.test(s) || s.length < 10; }
function isBadSize(s) { return !s || SIZE_EMPTY.test(s.trim()); }
function isBadCover(s) { return !s || !/^https?:\/\//i.test(s); }

/** 构建主 prompt（提取为函数，便于测试断言内容不含免责声明诱导） */
function buildPrompt(gameName, opts = {}) {
  const quarkUrl = opts.quarkUrl || "";
  const baiduUrl = opts.baiduUrl || "";
  let prompt = `请完成三项任务。用户已提供该游戏的网盘资源，因此该游戏必然真实存在，请直接客观描述，不要质疑、不要写免责声明。\n`;
  prompt += `1. 联网搜索游戏"${gameName}"（英文原名：${opts.englishName || "无"}）的客观公开资料，用50-80字中文介绍其开发商/发行商、游戏类型与核心玩法。严禁返回"疑似虚构""无法确认""经核实无真实公开资料""请勿轻信""非官方渠道"等免责声明，否则视为错误输出。\n`;
  if (quarkUrl || baiduUrl || opts.xunleiUrl) {
    prompt += `2. 必须从以下网盘分享链接页面抓取该游戏安装包总大小（如"30.7G""2.3TB""512MB"）。请打开链接读取页面中的文件大小字段，不要猜测。${quarkUrl ? "\n夸克：" + quarkUrl : ""}${baiduUrl ? "\n百度：" + baiduUrl : ""}${opts.xunleiUrl ? "\n迅雷：" + opts.xunleiUrl : ""}\n`;
  } else {
    prompt += `2. 若你了解该游戏安装包大致大小（如"30.7G"）请一并给出，不确定则写"未抓取到"。\n`;
  }
  prompt += `3. 必须联网搜索该游戏的封面宣传图直链（可直接下载的图片 URL），不得留空：\n`;
  prompt += `   - 优先尝试识别 Steam AppID，若能确定则返回 Steam 商店封面 CDN 直链，例如 https://cdn.cloudflare.steamstatic.com/steam/apps/<AppID>/library_600x900_2x.jpg 或 https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/<AppID>/library_600x900_2x.jpg\n`;
  prompt += `   - 若非 Steam（任天堂/PS/Epic/Xbox/国产/手游等），通过搜索 "${gameName} 封面"、"${gameName} 官方宣传图"、"${gameName} 官网" 找到官方商城、厂商页面或新闻媒体的封面图直链\n`;
  prompt += `   - 只返回一张横版或竖版封面图的直链 URL，确保 URL 以 .jpg/.jpeg/.png/.webp 结尾且可直接下载\n`;
  prompt += `严格按以下格式单行输出，不要多余内容：\n介绍：<50-80字真实介绍>\n大小：<如 30.7G，未抓取到则写"未抓取到">\n封面：<封面图直链URL，必须返回>`;
  return prompt;
}

/** 解析 bl 一次输出的纯函数（可单测）。返回解析结果与质量标志。 */
function parseSingle(content, { gameName, rawLine, opts = {} } = {}) {
  const introM = content.match(/介绍[:：]\s*([^\n]*)/);
  const sizeM = content.match(/大小[:：][ \t]*([^\n]*)/);
  const coverM = content.match(/封面[:：]\s*([^\n]*)/);
  let coverUrl = "";
  if (coverM) {
    const urlM = coverM[1].match(/https?:\/\/[^\s）)]+/);
    coverUrl = urlM ? urlM[0] : "";
  }
  let intro = (introM?.[1] || "").replace(/[\n\r]+/g, " ").trim().slice(0, 200);
  if (isBadIntro(intro)) intro = "";
  const rawSize = (sizeM?.[1] || "").trim();
  let size = isBadSize(rawSize) ? "" : rawSize;
  return {
    intro, size, coverUrl,
    badIntro: isBadIntro(intro),
    badSize: isBadSize(size) && !!(opts.quarkUrl || opts.baiduUrl || opts.xunleiUrl),
    badCover: isBadCover(coverUrl),
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

/** 用 bl 生成游戏介绍、抓取大小、并联网搜索封面图直链（bl 即内置 agent：介绍+大小+封面三件事都交给 bl） */
async function aiDescribe(gameName, rawLine, opts = {}) {
  const run = opts.runCmd || runCmd;
  const quarkUrl = opts.quarkUrl || "";
  const baiduUrl = opts.baiduUrl || "";
  try {
    const out = await run([
      "text", "chat",
      "--message", buildPrompt(gameName, opts),
      "--max-tokens", "600",
      "--output", "json",
    ], { timeout: 60000 });
    const content = extractContent(out);
    const r1 = parseSingle(content, { gameName, rawLine, opts });
    let { intro, size, coverUrl } = r1;

    // 强制重试：首次输出质量不合格时，分项再追一次
    if (r1.badIntro || r1.badSize || r1.badCover) {
      let retryPrompt = `请为游戏"${gameName}"（英文：${opts.englishName || "无"}）补全以下信息，不要编造、不要写免责声明。\n`;
      if (r1.badIntro) retryPrompt += `1. 联网搜索该游戏开发商/类型/核心玩法，输出50-80字中文客观介绍。\n`;
      if (r1.badSize) retryPrompt += `2. 打开网盘链接读取安装包总大小：${quarkUrl || baiduUrl || opts.xunleiUrl}\n`;
      if (r1.badCover) retryPrompt += `3. 联网搜索一张官方封面/宣传图直链（.jpg/.jpeg/.png/.webp）。\n`;
      retryPrompt += "严格按格式输出（缺失项可写 无）:\n";
      if (r1.badIntro) retryPrompt += "介绍：<客观介绍>\n";
      if (r1.badSize) retryPrompt += "大小：<如 30.7G>\n";
      if (r1.badCover) retryPrompt += "封面：<URL>\n";
      try {
        const out2 = await run([
          "text", "chat",
          "--message", retryPrompt,
          "--max-tokens", r1.badIntro ? "600" : "300",
          "--output", "json",
        ], { timeout: 45000 });
        const content2 = extractContent(out2);
        const r2 = parseSingle(content2, { gameName, rawLine, opts });
        if (r1.badIntro && !r2.badIntro) intro = r2.intro;
        if (r1.badSize && !r2.badSize) size = r2.size;
        if (r1.badCover && !r2.badCover) coverUrl = r2.coverUrl;
      } catch { /* 忽略二次失败 */ }
    }

    // 最终保底：若仍无介绍，用原始文本兜底（至少不是免责声明）
    if (!intro) intro = rawLine;
    return { intro, size, coverUrl };
  } catch { return { intro: rawLine || "", size: "", coverUrl: "" }; }
}

module.exports = {
  checkBlAvailable, aiDescribe, parseSingle, buildPrompt,
  INTRO_BLACKLIST, isBadIntro, isBadSize, isBadCover,
};
