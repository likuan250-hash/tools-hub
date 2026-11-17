const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseBiliMarkdown, readMetadata } = require("../lib/folder-meta");

const SAMPLE = `标题：【游戏371】小小梦魇团队回来了——生灵重塑

简介：
第一行简介

第二行简介

标签：生灵重塑,小小梦魇,恐怖游戏
`;

test("parseBiliMarkdown：解析标题、多行简介和标签", () => {
  const r = parseBiliMarkdown(SAMPLE);
  assert.equal(r.title, "【游戏371】小小梦魇团队回来了——生灵重塑");
  assert.match(r.description, /第一行简介/);
  assert.match(r.description, /第二行简介/);
  assert.deepEqual(r.tags, ["生灵重塑", "小小梦魇", "恐怖游戏"]);
});

test("readMetadata：读取标准素材目录文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-meta-"));
  fs.writeFileSync(path.join(dir, "B站标题与简介.md"), SAMPLE);
  const r = readMetadata(dir);
  assert.match(r.title, /^【游戏371】/);
  assert.match(r.file, /B站标题与简介\.md$/);
});
