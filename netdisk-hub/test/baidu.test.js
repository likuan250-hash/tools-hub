// baidu.js HTTP 接口层测试（全局 fetch mock，不联网、不启浏览器）
// 覆盖：getShareList HTML 解析、transfer errno 处理、createShare 链接格式、
//       verifyCookie（-6 退回仅核心 cookie 重试）、parseSurl。
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

// 每个测试文件是独立进程：在 require store/baidu 之前注入临时数据目录与密钥文件，
// 避免污染真实 userData 且让加解密可独立进行。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nd-baidu-test-"));
process.env.NETDISK_DATA_DIR = TMP;
process.env.NETDISK_KEY_FILE = path.join(TMP, ".masterkey");

const store = require("../src/store");
const baidu = require("../src/baidu");

// ── fetch mock ───────────────────────────────────────────────
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
});
after(() => {
  if (restoreFetch) restoreFetch();
});

// 代表性分享页 HTML：含 shareid / share_uk / 两个 fs_id 及各自 server_filename
const SAMPLE_HTML = `
{"shareid":1234567, "share_uk":"7654321", "uk":7654321,
 "file_list":[
   {"fs_id":111, "server_filename":"游戏合集.iso", "size":3072000000},
   {"fs_id":222, "server_filename":"说明.txt", "size":1024}
 ]}
`;

function bdstokenOk() {
  return { errno: 0, result: { bdstoken: "TOKEN_XYZ" } };
}

test("parseSurl：从完整链接/短码/查询参数提取 surl（保留前导1，由 getShareList 内剥离）", () => {
  assert.strictEqual(baidu.parseSurl("https://pan.baidu.com/s/1AbC123def"), "1AbC123def");
  assert.strictEqual(baidu.parseSurl("https://pan.baidu.com/share/init?surl=Zz9Zz"), "Zz9Zz");
  assert.strictEqual(baidu.parseSurl("plaincode"), "plaincode");
});

test("getShareList：解析分享页 HTML，正确配对 fs_id 与文件名", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc; STOKEN=def" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/s/")) return [SAMPLE_HTML, 200, { "Content-Type": "text/html" }];
    return [{}, 200, {}];
  });
  const r = await baidu.getShareList("1AbC123def", "");
  assert.strictEqual(r.shareid, "1234567");
  assert.strictEqual(r.uk, "7654321");
  assert.strictEqual(r.list.length, 2);
  assert.deepStrictEqual(r.list[0], { fs_id: "111", server_filename: "游戏合集.iso", size: 0 });
  assert.deepStrictEqual(r.list[1], { fs_id: "222", server_filename: "说明.txt", size: 0 });
});

test("getShareList：带提取码时调用 verify 并写入 BDCLND", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  let verifyCalled = false;
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/share/verify")) {
      verifyCalled = true;
      return [{ errno: 0, randsk: "RAND_SK" }];
    }
    if (url.includes("/s/")) return [SAMPLE_HTML, 200, { "Content-Type": "text/html" }];
    return [{}, 200, {}];
  });
  await baidu.getShareList("1AbC123def", "8888");
  assert.strictEqual(verifyCalled, true);
});

test("getShareList：解析失败（无文件列表）抛错", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/s/"))
      return ['{"shareid":1,"share_uk":"2"}', 200, { "Content-Type": "text/html" }];
    return [{}, 200, {}];
  });
  await assert.rejects(() => baidu.getShareList("1X", ""), /未能从分享页解析出文件列表/);
});

test("transfer：errno 0 视为成功", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/share/transfer"))
      return [
        {
          errno: 0,
          task_id: "T1",
          file_list: [{ fs_id: 111, path: "/x", server_filename: "a", size: 1 }],
        },
      ];
    return [{}, 200, {}];
  });
  const r = await baidu.transfer("123", "765", ["111"], "/apps/netdisk_hub");
  assert.strictEqual(r.errno, 0);
  assert.strictEqual(r.task_id, "T1");
  assert.strictEqual(r.file_list.length, 1);
});

test("transfer：errno 4（目录已存在同名文件）也视作成功", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/share/transfer"))
      return [
        {
          errno: 4,
          task_id: "T2",
          file_list: [],
          duplicated: { list: [{ fs_id: 111, path: "/x", server_filename: "a", size: 1 }] },
        },
      ];
    return [{}, 200, {}];
  });
  const r = await baidu.transfer("123", "765", ["111"], "/apps/netdisk_hub");
  assert.strictEqual(r.errno, 4);
  assert.strictEqual(r.file_list.length, 1, "duplicated 应合并进 file_list");
});

test("transfer：errno 12（文件已存在）视作成功", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/share/transfer"))
      return [
        {
          errno: 12,
          task_id: "T3",
          file_list: [{ fs_id: 111, path: "/x", server_filename: "a", size: 1 }],
        },
      ];
    return [{}, 200, {}];
  });
  const r = await baidu.transfer("123", "765", ["111"], "/apps/netdisk_hub");
  assert.strictEqual(r.errno, 12);
});

test("transfer：非 0/4/12 的 errno 抛错", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/share/transfer")) return [{ errno: -6, errmsg: "login" }];
    return [{}, 200, {}];
  });
  await assert.rejects(() => baidu.transfer("123", "765", ["111"], "/x"), /转存失败 errno=-6/);
});

test("createShare：返回链接内嵌提取码 8888", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((url) => {
    if (url.includes("/api/gettemplatevariable")) return [bdstokenOk()];
    if (url.includes("/share/set"))
      return [{ errno: 0, link: "https://pan.baidu.com/s/AbCdEfG9", shareid: 555 }];
    return [{}, 200, {}];
  });
  const r = await baidu.createShare(["111"], 0, "");
  assert.strictEqual(r.link, "https://pan.baidu.com/s/AbCdEfG9?pwd=8888");
  assert.strictEqual(r.password, "8888");
  assert.strictEqual(r.shareid, 555);
});

test("verifyCookie：errno 0 直接成功", async () => {
  global.fetch = makeFetch(() => [{ errno: 0, result: { bdstoken: "X" } }]);
  const r = await baidu.verifyCookie("BDUSS=abc; STOKEN=def");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.errno, 0);
});

test("verifyCookie：全量 errno -6 后退回仅核心 cookie 重试成功", async () => {
  let calls = 0;
  global.fetch = makeFetch((url, opts) => {
    if (url.includes("/api/gettemplatevariable")) {
      calls++;
      if (calls === 1) return [{ errno: -6 }]; // 全量触发 -6
      return [{ errno: 0, result: { bdstoken: "X" } }]; // 仅核心 cookie 重试成功
    }
    return [{}, 200, {}];
  });
  const r = await baidu.verifyCookie("BDUSS=abc; STOKEN=def; XFI=garbage");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.minimal, true, "应标记走了 minimal 重试路径");
  assert.strictEqual(calls, 2, "应触发两次请求（全量 + 仅核心）");
});

test("verifyCookie：空 cookie 直接失败", async () => {
  const r = await baidu.verifyCookie("");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errno, "no_cookie");
});

test("searchFiles：列目录第一层并按关键词过滤", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  global.fetch = makeFetch((u) => {
    if (u.includes("/api/list"))
      return [
        {
          errno: 0,
          list: [
            { fs_id: 1, server_filename: "消逝的光芒2.iso", isdir: 0, size: 100 },
            { fs_id: 2, server_filename: "说明.txt", isdir: 0, size: 5 },
            { fs_id: 3, server_filename: "游戏合集", isdir: 1 },
          ],
        },
      ];
    return [{ errno: 0, result: { bdstoken: "T" } }];
  });
  const r = await baidu.searchFiles("/", "光芒");
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, "1");
  assert.strictEqual(r[0].name, "消逝的光芒2.iso");
  assert.strictEqual(r[0].isdir, false);
});

test("trashFiles：POST /api/filemanager opera=delete 进回收站", async () => {
  store.saveAccount("baidu", { cookie: "BDUSS=abc" });
  let sent = null;
  global.fetch = makeFetch((u, opts) => {
    if (u.includes("gettemplatevariable")) return [{ errno: 0, result: { bdstoken: "T" } }];
    sent = { url: String(u), body: String(opts.body) };
    return [{ errno: 0 }];
  });
  await baidu.trashFiles(["1", "2"]);
  assert.ok(sent.url.includes("opera=delete"));
  assert.ok(sent.url.includes("async=2"));
  assert.ok(decodeURIComponent(sent.body).includes("filelist=[1,2]"));
});
