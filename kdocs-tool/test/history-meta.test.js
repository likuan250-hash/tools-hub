const test = require("node:test");
const assert = require("node:assert");
const { extractVersion, countDiskLinks, buildHistorySubtitle } = require("../public/history-meta");

test("extractVersion 抽取 v前缀版本号", () => {
  assert.strictEqual(extractVersion("最后的生还者2：重制版 v1.6.10721.0105 官方中文"), "v1.6.10721.0105");
  assert.strictEqual(extractVersion("Cyberpunk 2077 v2.1"), "", "v2.1 只有一段小数不算版本号");
  assert.strictEqual(extractVersion("巫师3 v1.6 官方中文"), "", "v1.6 只有一段小数不算版本号");
  assert.strictEqual(extractVersion("Build.1234.5678.9"), "1234.5678.9", "纯数字四段也算");
});

test("extractVersion 三段及以上才算版本号（与 Build.123 区分）", () => {
  // 业务里版本号至少三段（x.y.z），避免误抓普通小数
  assert.strictEqual(extractVersion("Game v1.2.3"), "v1.2.3");
  assert.strictEqual(extractVersion("v1.2.3.4"), "v1.2.3.4");
});

test("extractVersion 空/非字符串安全返回空", () => {
  assert.strictEqual(extractVersion(""), "");
  assert.strictEqual(extractVersion(null), "");
  assert.strictEqual(extractVersion(undefined), "");
});

test("countDiskLinks 统计多个网盘链接（按完整 URL 去重）", () => {
  const text = `最后的生还者2：重制版 v1.6.10721.0105 官方中文
链接: https://pan.baidu.com/s/14ztFdBXED5BgIiFDrsWzFg?pwd=8888
链接：https://pan.quark.cn/s/ca5d3822f595
链接：https://pan.xunlei.com/s/VOzBYWgOrjudIdrxus_FD-xLA1?pwd=22z8#`;
  assert.strictEqual(countDiskLinks(text), 3);
});

test("countDiskLinks 同一域名多个 URL 只计一次", () => {
  const text = `链接: https://pan.baidu.com/s/abc
链接: https://pan.baidu.com/s/def`;
  assert.strictEqual(countDiskLinks(text), 2, "按完整 URL 去重，不同 URL 都计");
});

test("countDiskLinks 无网盘链接返回 0", () => {
  assert.strictEqual(countDiskLinks("纯文本，无链接"), 0);
  assert.strictEqual(countDiskLinks(""), 0);
});

test("countDiskLinks 支持常见国内网盘域（夸克/百度/迅雷/阿里/123pan/微云/城通）", () => {
  assert.strictEqual(countDiskLinks("链接 https://pan.quark.cn/s/x"), 1);
  assert.strictEqual(countDiskLinks("链接 https://aliyundrive.com/s/x"), 1);
  assert.strictEqual(countDiskLinks("链接 https://123pan.com/s/x"), 1);
  assert.strictEqual(countDiskLinks("链接 https://ctfile.com/s/x"), 1);
  // 非网盘域名不计
  assert.strictEqual(countDiskLinks("链接 https://store.steampowered.com/app/123"), 0);
});

test("buildHistorySubtitle 同时含版本+网盘时拼接", () => {
  const text = `游戏名 v1.6.10721.0105
链接 https://pan.baidu.com/s/abc
链接 https://pan.quark.cn/s/xyz`;
  assert.strictEqual(buildHistorySubtitle(text), "v1.6.10721.0105 · 2网盘");
});

test("buildHistorySubtitle 仅版本无网盘", () => {
  assert.strictEqual(buildHistorySubtitle("游戏 v1.0.0 介绍"), "v1.0.0");
});

test("buildHistorySubtitle 仅网盘无版本", () => {
  assert.strictEqual(buildHistorySubtitle("游戏 链接 https://pan.baidu.com/s/abc"), "1网盘");
});

test("buildHistorySubtitle 全空返回空串", () => {
  assert.strictEqual(buildHistorySubtitle("纯文本"), "");
  assert.strictEqual(buildHistorySubtitle(""), "");
});