const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseBiliMarkdown, findVideo, readFolderMeta } = require("../lib/folderMeta");

const SAMPLE = `标题：【游戏371】小小梦魇团队回来了——生灵重塑，这次要逃出一座岛

简介：
生灵重塑（REANIMAL）| 官方中文

做《小小梦魇》I 和 II 的那帮人回来了。

标签：生灵重塑,小小梦魇,恐怖游戏,双人合作
`;

test("parseBiliMarkdown：读取标题、多行简介、标签", () => {
  const r = parseBiliMarkdown(SAMPLE);
  assert.match(r.title, /^【游戏371】/);
  assert.match(r.description, /REANIMAL/);
  assert.match(r.description, /那帮人回来了/);
  assert.deepEqual(r.tags, ["生灵重塑", "小小梦魇", "恐怖游戏", "双人合作"]);
});

test("findVideo：只选成品，不把预告片当成品", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-folder-meta-"));
  fs.writeFileSync(path.join(dir, "【1080P】《生灵重塑》- 发售预告片.mp4"), "");
  fs.writeFileSync(path.join(dir, "【游戏371】生灵重塑 成片.mp4"), "");
  fs.writeFileSync(path.join(dir, "B站标题与简介.md"), SAMPLE);
  const info = readFolderMeta(dir);
  assert.equal(info.video, "【游戏371】生灵重塑 成片.mp4");
  assert.equal(info.metadata.title.startsWith("【游戏371】"), true);
});

test("readFolderMeta：只有预告片时返回成品缺失", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-folder-meta-"));
  fs.writeFileSync(path.join(dir, "【1080P】《生灵重塑》- 发售预告片.mp4"), "");
  fs.writeFileSync(path.join(dir, "B站标题与简介.md"), SAMPLE);
  const info = readFolderMeta(dir);
  assert.equal(info.video, null);
  assert.equal(info.videoErrorCode, "FINAL_VIDEO_MISSING");
  assert.match(info.videoError, /成品视频缺失/);
});
