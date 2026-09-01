// xunlei.js HTTP 接口层测试（全局 fetch mock，经 setAuthForTest 注入令牌跳过浏览器）
// 覆盖：getShareInfo、restore、createShare、findFolder、transfer 编排、parseSurl。
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nd-xunlei-test-"));
process.env.NETDISK_DATA_DIR = TMP;
process.env.NETDISK_KEY_FILE = path.join(TMP, ".masterkey");

const store = require("../src/store");
const xunlei = require("../src/xunlei");

function makeFetch(router) {
  return async (url, opts) => {
    const arr = router(url, opts) || [{}, 200, {}];
    const body = arr[0] !== undefined ? arr[0] : {};
    const status = arr[1] !== undefined ? arr[1] : 200;
    const headers = arr[2] || {};
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(headers)),
      async json() {
        return typeof body === "string" ? JSON.parse(body) : body;
      },
      async text() {
        return text;
      },
    };
  };
}

let restoreFetch = null;
before(() => {
  const orig = global.fetch;
  restoreFetch = () => {
    global.fetch = orig;
  };
  // 注入有效令牌，跳过 Playwright 浏览器读取
  xunlei.setAuthForTest({ access_token: "AT", captcha: "CT", device_id: "DID" });
});
after(() => {
  if (restoreFetch) restoreFetch();
});

test("parseSurl：补全为完整迅雷分享链接（支持完整 URL / ?s= 查询 / 纯短码）", () => {
  assert.strictEqual(
    xunlei.parseSurl("https://pan.xunlei.com/s/AbC123"),
    "https://pan.xunlei.com/s/AbC123",
  );
  assert.strictEqual(xunlei.parseSurl("?s=AbC123"), "https://pan.xunlei.com/s/AbC123");
  assert.strictEqual(xunlei.parseSurl("rawcode"), "https://pan.xunlei.com/s/rawcode");
});

test("getShareInfo：解析 files 与 pass_code_token", async () => {
  global.fetch = makeFetch((url) => {
    if (url.includes("/share"))
      return [{ data: { files: [{ id: "fid1", name: "a.iso", size: 9 }], pass_code_token: "PT" } }];
    return [{}, 200, {}];
  });
  const r = await xunlei.getShareInfo("SH1", "");
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].id, "fid1");
  assert.strictEqual(r.passCodeToken, "PT");
});

test("getShareInfo：分享为空抛错", async () => {
  global.fetch = makeFetch(() => [{ data: { files: [] } }]);
  await assert.rejects(() => xunlei.getShareInfo("SH1", ""), /该分享为空/);
});

test("restore：返回 restore_task_id", async () => {
  global.fetch = makeFetch(() => [{ restore_task_id: "RT1" }]);
  const id = await xunlei.restore("SH1", "PT", ["fid1"], "DEST");
  assert.strictEqual(id, "RT1");
});

test("createShare：返回带提取码链接", async () => {
  global.fetch = makeFetch(() => [
    { data: { share_url: "https://pan.xunlei.com/s/Abcde", pass_code: "p1", share_id: "S1" } },
  ]);
  const r = await xunlei.createShare(["fid1"]);
  assert.strictEqual(r.link, "https://pan.xunlei.com/s/Abcde?pwd=p1#");
  assert.strictEqual(r.password, "p1");
  assert.strictEqual(r.shareId, "S1");
});

test("findFolder：按名精确匹配文件夹", async () => {
  global.fetch = makeFetch((url) => {
    if (url.includes("/files"))
      return [
        {
          files: [
            { id: "X1", name: "游戏", kind: "drive#folder" },
            { id: "X2", name: "音乐", kind: "drive#file" },
          ],
        },
      ];
    return [{}, 200, {}];
  });
  const f = await xunlei.findFolder("游戏");
  assert.deepStrictEqual(f, { id: "X1", name: "游戏" });
  const none = await xunlei.findFolder("不存在");
  assert.strictEqual(none, null);
});

test("transfer：完整编排（指定目标目录 + 生成分享）", async () => {
  global.fetch = makeFetch((url, opts) => {
    const isPost = opts && opts.method === "POST";
    if (url.includes("/share/restore")) return [{ restore_task_id: "RT1" }];
    if (url.includes("/tasks/"))
      return [{ progress: 100, params: { trace_file_ids: '{"a":"fid1"}' } }];
    if (url.includes("/share") && isPost)
      return [
        { data: { share_url: "https://pan.xunlei.com/s/Abcde", pass_code: "p1", share_id: "S1" } },
      ];
    if (url.includes("/share"))
      return [{ data: { files: [{ id: "fid1", name: "a.iso", size: 9 }], pass_code_token: "PT" } }];
    return [{}, 200, {}];
  });
  const r = await xunlei.transfer({
    link: "https://pan.xunlei.com/s/SH1",
    pwd: "",
    makeShare: true,
    destFolderId: "DEST",
    destFolderName: "游戏",
  });
  assert.strictEqual(r.file_list.length, 1);
  assert.strictEqual(r.file_list[0].server_filename, "a.iso");
  assert.ok(r.share, "应生成分享");
  assert.strictEqual(r.share.link, "https://pan.xunlei.com/s/Abcde?pwd=p1#");
  assert.strictEqual(r.destPath, "/游戏");
  assert.strictEqual(r.task_id, "RT1");
});

test("transfer：未指定目录时按名查找「游戏」", async () => {
  global.fetch = makeFetch((url, opts) => {
    const isPost = opts && opts.method === "POST";
    if (url.includes("/share/restore")) return [{ restore_task_id: "RT1" }];
    if (url.includes("/tasks/"))
      return [{ progress: 100, params: { trace_file_ids: '{"a":"fid1"}' } }];
    if (url.includes("/share") && isPost)
      return [
        { data: { share_url: "https://pan.xunlei.com/s/Abcde", pass_code: "", share_id: "S1" } },
      ];
    if (url.includes("/share"))
      return [{ data: { files: [{ id: "fid1", name: "a.iso", size: 9 }], pass_code_token: "PT" } }];
    // listFiles：用于 findFolder('游戏')
    if (url.includes("/files"))
      return [{ files: [{ id: "GAME", name: "游戏", kind: "drive#folder" }] }];
    return [{}, 200, {}];
  });
  const r = await xunlei.transfer({
    link: "https://pan.xunlei.com/s/SH1",
    pwd: "",
    makeShare: false,
  });
  assert.strictEqual(r.destPath, "/游戏");
  assert.strictEqual(r.share, null);
});

test("searchFiles：列目录第一层并按关键词过滤", async () => {
  global.fetch = makeFetch((u) => {
    if (String(u).includes("/files"))
      return [
        {
          files: [
            { id: "x1", name: "消逝的光芒2.iso", kind: "drive#file", size: 100 },
            { id: "x2", name: "说明.txt", kind: "drive#file", size: 5 },
            { id: "x3", name: "游戏合集", kind: "drive#folder", size: 0 },
          ],
        },
      ];
    return [{ files: [] }];
  });
  const r = await xunlei.searchFiles("", "光芒");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, "x1");
  assert.strictEqual(r[0].isdir, false);
});

test("trashFiles：POST /files:batchDelete 进回收站", async () => {
  let sent = null;
  global.fetch = makeFetch((u, opts) => {
    if (String(u).includes("files:batchDelete")) {
      sent = JSON.parse(opts.body);
      return [{ ok: true }, 200];
    }
    return [{}, 200];
  });
  await xunlei.trashFiles(["x1", "x2"]);
  assert.deepStrictEqual(sent.ids, ["x1", "x2"]);
  assert.strictEqual(sent.space, "");
});
