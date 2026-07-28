// parser.test.js — 输入文本解析单元测试
const test = require("node:test");
const assert = require("node:assert");
const { parseInput } = require("../lib/parser");

test("清洗带 Build/版本/补丁/免安装长尾的游戏名", () => {
  const p = parseInput("双影奇境（Split Fiction）Build.18353366 (v20250527) 官方中文+联机补丁+升级补丁 免安装硬盘版\n夸克：https://pan.quark.cn/s/abc123");
  assert.strictEqual(p.gameName, "双影奇境");
  assert.strictEqual(p.englishName, "Split Fiction");
  assert.ok(p.tags.includes("PC游戏"));
  assert.ok(p.tags.includes("免安装硬盘版"));
  assert.ok(p.tags.includes("联机合作"));
  assert.strictEqual(p.quarkUrl, "https://pan.quark.cn/s/abc123");
});

test("无括号纯中文名 + 显式大小", () => {
  const p = parseInput("艾尔登法环 黄金树幽影\n大小：60G");
  assert.strictEqual(p.gameName, "艾尔登法环 黄金树幽影");
  assert.strictEqual(p.englishName, "");
  assert.strictEqual(p.size, "60G");
});

test("识别百度与迅雷网盘链接", () => {
  const p = parseInput("测试游戏\n百度：https://pan.baidu.com/s/xyz\n迅雷：https://pan.xunlei.com/s/abc");
  assert.strictEqual(p.baiduUrl, "https://pan.baidu.com/s/xyz");
  assert.strictEqual(p.xunleiUrl, "https://pan.xunlei.com/s/abc");
  assert.strictEqual(p.quarkUrl, "");
});

test("抽取手动封面链接", () => {
  const p = parseInput("测试游戏\n封面：https://example.com/pic.png");
  assert.strictEqual(p.coverUrl, "https://example.com/pic.png");
});

test("大小带单位 TB/MB 均识别", () => {
  assert.strictEqual(parseInput("a\n容量：2.3TB").size, "2.3TB");
  assert.strictEqual(parseInput("a\n体积：512MB").size, "512MB");
});

test("空输入返回 null", () => {
  assert.strictEqual(parseInput("   \n  "), null);
});

test("多标签逗号/空格分隔均识别", () => {
  const p = parseInput("测试游戏\n标签：动作,角色扮演,单机");
  assert.ok(p.tags.includes("动作") && p.tags.includes("角色扮演") && p.tags.includes("单机"));
  const p2 = parseInput("测试游戏\n标签：射击 冒险 RPG");
  assert.ok(p2.tags.includes("射击") && p2.tags.includes("冒险") && p2.tags.includes("RPG"));
});

test("「大小：」前缀提取游戏大小", () => {
  assert.strictEqual(parseInput("a\n大小：30.7G").size, "30.7G");
  assert.strictEqual(parseInput("a\n大小: 512MB").size, "512MB");
});

test("提取英文名（无中文括号时为空）", () => {
  assert.strictEqual(parseInput("Hades II").englishName, "");
  assert.strictEqual(parseInput("黑神话悟空（Black Myth Wukong）").englishName, "Black Myth Wukong");
});
