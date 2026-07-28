// ai.test.js — bl 集成单元测试（用 fake runCmd 注入，不依赖真实 bl）
const test = require("node:test");
const assert = require("node:assert");
const { aiDescribe, parseSingle, isBadIntro, isBadSize, isBadCover, buildPrompt } = require("../lib/ai");

// 模拟 bl 正常 JSON 输出
function fakeBlReturning(obj) {
  return (cmd) =>
    JSON.stringify({ choices: [{ message: { content: obj.content } }] });
}

test("parseSingle 正常解析介绍/大小/封面", () => {
  const r = parseSingle("介绍：这是一款动作冒险游戏。\n大小：30.7G\n封面：https://cdn.x.com/a.jpg", {
    gameName: "测试", rawLine: "测试",
  });
  assert.strictEqual(r.intro, "这是一款动作冒险游戏。");
  assert.strictEqual(r.size, "30.7G");
  assert.strictEqual(r.coverUrl, "https://cdn.x.com/a.jpg");
  assert.strictEqual(r.badIntro, false);
  assert.strictEqual(r.badSize, false);
  assert.strictEqual(r.badCover, false);
});

test("parseSingle 含免责声明时 intro 被丢弃", () => {
  const r = parseSingle("介绍：该游戏经核实无真实公开资料，疑似虚构或误传，请勿轻信。\n大小：未抓取到\n封面：", {
    gameName: "测试", rawLine: "测试",
  });
  assert.strictEqual(r.intro, "");
  assert.strictEqual(r.badIntro, true);
});

test("parseSingle 大小未抓取到视为空", () => {
  const r = parseSingle("介绍：正常介绍内容足够长。\n大小：未抓取到\n封面：", {
    gameName: "测试", rawLine: "测试",
  });
  assert.strictEqual(r.size, "");
  assert.strictEqual(r.badSize, false); // 无网盘链接时，大小空不算需重试
});

test("提供网盘链接时大小为空才触发 badSize", () => {
  const r = parseSingle("介绍：正常介绍内容足够长。\n大小：未抓取到\n封面：", {
    gameName: "测试", rawLine: "测试", opts: { quarkUrl: "https://pan.quark.cn/s/x" },
  });
  assert.strictEqual(r.badSize, true);
});

test("封面 URL 带括号后缀可正确提取", () => {
  const r = parseSingle("封面：https://x.com/a.jpg (直链)", {
    gameName: "测试", rawLine: "测试",
  });
  assert.strictEqual(r.coverUrl, "https://x.com/a.jpg");
});

test("aiDescribe：bl 正常返回 → 解析结果透传", async () => {
  const res = await aiDescribe("双影奇境", "双影奇境（Split Fiction）", {
    runCmd: fakeBlReturning({ content: "介绍：Hazelight 开发的双人合作冒险游戏。\n大小：30.7G\n封面：https://cdn.x.com/a.jpg" }),
  });
  assert.strictEqual(res.intro, "Hazelight 开发的双人合作冒险游戏。");
  assert.strictEqual(res.size, "30.7G");
  assert.strictEqual(res.coverUrl, "https://cdn.x.com/a.jpg");
});

test("aiDescribe：首次免责声明 + 二次正常 → 取二次介绍", async () => {
  let call = 0;
  const runCmd = (cmd) => {
    call++;
    if (call === 1) return JSON.stringify({ choices: [{ message: { content: "介绍：该游戏经核实无真实公开资料，疑似虚构，请勿轻信。\n大小：未抓取到\n封面：" } }] });
    return JSON.stringify({ choices: [{ message: { content: "介绍：Hazelight 开发的双人合作冒险游戏。\n大小：30.7G\n封面：https://cdn.x.com/a.jpg" } }] });
  };
  const res = await aiDescribe("双影奇境", "双影奇境（Split Fiction）", { runCmd, quarkUrl: "https://pan.quark.cn/s/x" });
  assert.strictEqual(call, 2);
  assert.strictEqual(res.intro, "Hazelight 开发的双人合作冒险游戏。");
  assert.strictEqual(res.size, "30.7G");
  assert.strictEqual(res.coverUrl, "https://cdn.x.com/a.jpg");
});

test("aiDescribe：runCmd 抛错 → 兜底原始文本", async () => {
  const res = await aiDescribe("双影奇境", "双影奇境（Split Fiction）", {
    runCmd: () => { throw new Error("bl crash"); },
  });
  assert.strictEqual(res.intro, "双影奇境（Split Fiction）");
  assert.strictEqual(res.size, "");
  assert.strictEqual(res.coverUrl, "");
});

test("buildPrompt 不含诱导虚构的措辞，含强制要求", () => {
  const p = buildPrompt("双影奇境", { quarkUrl: "https://pan.quark.cn/s/x" });
  assert.ok(p.includes("必须返回"));
  assert.ok(p.includes("不要写免责声明"));
  assert.ok(p.includes("必须"));
  assert.ok(!p.includes("严禁编造")); // 旧的诱导措辞已移除
  assert.ok(p.includes("https://pan.quark.cn/s/x"));
});

test("isBad* 工具函数", () => {
  assert.strictEqual(isBadIntro("短"), true);
  assert.strictEqual(isBadIntro("长度足够的正常介绍内容。"), false);
  assert.strictEqual(isBadSize("未抓取到"), true);
  assert.strictEqual(isBadSize("30.7G"), false);
  assert.strictEqual(isBadCover("https://x.com/a.jpg"), false);
  assert.strictEqual(isBadCover(""), true);
});
