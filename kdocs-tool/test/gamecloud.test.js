// gamecloud.test.js — 游戏库云服务客户端单测（注入 fake http，不联网、不写数据）
const test = require("node:test");
const assert = require("node:assert");
const gc = require("../lib/gamecloud");

/** 构造可注入的假 http：记录每次调用，按 handler 返回响应。 */
function fakeHttp(handler) {
  const calls = [];
  const fn = async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    return handler(method, path, body, headers);
  };
  fn.calls = calls;
  fn.paths = () => calls.map((c) => c.path);
  return fn;
}

/** 标准响应：signin 成功 + 其余按 handler。 */
function okHandler(over = {}) {
  return async (method, path) => {
    if (path.endsWith("/signin")) {
      return { status: 200, json: { access_token: "tok-1", expires_in: 7199 } };
    }
    if (over[path]) return over[path];
    return { status: 200, json: {} };
  };
}

/** 临时设置密码环境变量并在结束后还原（异步安全：等 fn 落定再还原）。 */
async function withPassword(v, fn) {
  const old = process.env.QQBOT_ADMIN_PASSWORD;
  if (v == null) delete process.env.QQBOT_ADMIN_PASSWORD;
  else process.env.QQBOT_ADMIN_PASSWORD = v;
  gc.invalidateToken();
  try { return await fn(); } finally {
    if (old == null) delete process.env.QQBOT_ADMIN_PASSWORD;
    else process.env.QQBOT_ADMIN_PASSWORD = old;
    gc.invalidateToken();
  }
}

test("ORIGIN 必须与 EP 一致（token 与签发 Origin 强绑定，换 Origin 必 401）", () => {
  assert.strictEqual(gc.ORIGIN, gc.EP);
});

test("todayDash 输出 YYYY-MM-DD（云库只认这个格式，斜杠会被静默存 NULL）", () => {
  assert.match(gc.todayDash(), /^\d{4}-\d{2}-\d{2}$/);
});

test("normName 去空格 + 转小写（查重需自己精确比对）", () => {
  assert.strictEqual(gc.normName("  Split Fiction  "), "split fiction");
  assert.strictEqual(gc.normName(null), "");
});

test("buildRow 字段映射：名称/大小/标签/日期/三家网盘", () => {
  const parsed = {
    raw: "双影奇境（Split Fiction）",
    quarkUrl: "https://pan.quark.cn/s/q",
    baiduUrl: "https://pan.baidu.com/s/b",
    xunleiUrl: "https://pan.xunlei.com/s/x",
  };
  const row = gc.buildRow(parsed, { gameSize: "30.7G", tags: ["PC游戏", "全DLC"], date: "2026-09-24" });
  assert.strictEqual(row.name, "双影奇境（Split Fiction）");
  assert.strictEqual(row.size, "30.7G");
  assert.deepStrictEqual(row.tags, ["PC游戏", "全DLC"]);
  assert.strictEqual(row.doc_date, "2026-09-24");
  assert.strictEqual(row.url_quark, "https://pan.quark.cn/s/q");
  assert.strictEqual(row.url_baidu, "https://pan.baidu.com/s/b");
  assert.strictEqual(row.url_xunlei, "https://pan.xunlei.com/s/x");
});

test("buildRow 只回传白名单键（不带内部字段进 p_row）", () => {
  const row = gc.buildRow({ raw: "某游戏", 内部字段: "x", appid: "123" }, {});
  for (const k of Object.keys(row)) {
    assert.ok(gc.ROW_KEYS.includes(k), `不应出现白名单外的键：${k}`);
  }
});

test("buildRow 缺省 doc_date 自动补今天（避免静默 NULL）", () => {
  const row = gc.buildRow({ raw: "某游戏" }, {});
  assert.match(row.doc_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("hasCredentials：无环境变量为 false，有则为 true", async () => {
  await withPassword(null, () => assert.strictEqual(gc.hasCredentials(), false));
  await withPassword("pw", () => assert.strictEqual(gc.hasCredentials(), true));
});

test("未配置密码 → getToken 抛 NO_PASSWORD（供上层降级跳过，而不是报错）", async () => {
  await withPassword(null, async () => {
    await assert.rejects(
      () => gc.getToken({ _http: fakeHttp(okHandler()) }),
      (e) => e.code === gc.ERR_NO_PASSWORD,
    );
  });
});

test("findDup：p_status 必须硬编码 all（传空串会静默返回 0 条，查重形同虚设）", async () => {
  await withPassword("pw", async () => {
    const http = fakeHttp(okHandler({
      "/.cloud/database/rest/rpc/games_admin_page": { status: 200, json: { rows: [] } },
    }));
    await gc.findDup("某游戏", { _http: http });
    const call = http.calls.find((c) => c.path.endsWith("games_admin_page"));
    assert.ok(call, "应调用 games_admin_page");
    assert.strictEqual(call.body.p_status, "all");
  });
});

test("findDup：精确比对（忽略大小写与首尾空格），模糊命中不算重复", async () => {
  await withPassword("pw", async () => {
    const http = fakeHttp(okHandler({
      "/.cloud/database/rest/rpc/games_admin_page": {
        status: 200,
        json: { rows: [{ id: 1, name: "双影奇境（Split Fiction） 重制版" }, { id: 291, name: " 双影奇境（Split Fiction） " }] },
      },
    }));
    const hit = await gc.findDup("双影奇境（Split Fiction）", { _http: http });
    assert.strictEqual(hit.id, 291, "应命中精确同名那条，不能被模糊匹配带偏");
  });
});

test("findDup：无精确同名 → 返回 null", async () => {
  await withPassword("pw", async () => {
    const http = fakeHttp(okHandler({
      "/.cloud/database/rest/rpc/games_admin_page": { status: 200, json: { rows: [{ id: 1, name: "另一个游戏" }] } },
    }));
    assert.strictEqual(await gc.findDup("某游戏", { _http: http }), null);
  });
});

test("insert：p_id 恒为 null（物理上不可能改到或删掉已有记录）", async () => {
  await withPassword("pw", async () => {
    const http = fakeHttp(okHandler({
      "/.cloud/database/rest/rpc/games_admin_save": { status: 200, json: { id: 292, action: "insert" } },
    }));
    const res = await gc.insert({ name: "某游戏" }, { _http: http });
    const call = http.calls.find((c) => c.path.endsWith("games_admin_save"));
    assert.strictEqual(call.body.p_id, null);
    assert.strictEqual(res.id, 292);
    assert.strictEqual(res.action, "insert");
  });
});

test("insert：22023 参数错 → 抛 INSERT_BAD_ARGS（可读提示）", async () => {
  await withPassword("pw", async () => {
    const http = fakeHttp(okHandler({
      "/.cloud/database/rest/rpc/games_admin_save": { status: 400, json: { code: "22023", message: "name 不能为空" } },
    }));
    await assert.rejects(() => gc.insert({}, { _http: http }), (e) => e.code === "INSERT_BAD_ARGS");
  });
});

test("401 invalid_grant → 自动重登一次并重试（最多一次，防死循环）", async () => {
  await withPassword("pw", async () => {
    let pageTries = 0;
    const http = fakeHttp(async (method, path) => {
      if (path.endsWith("/signin")) return { status: 200, json: { access_token: "tok-" + Date.now(), expires_in: 7199 } };
      pageTries++;
      if (pageTries === 1) return { status: 401, json: { error: "invalid_grant" } };
      return { status: 200, json: { rows: [] } };
    });
    const hit = await gc.findDup("某游戏", { _http: http });
    assert.strictEqual(hit, null);
    assert.strictEqual(pageTries, 2, "应重试恰好一次");
    const signins = http.calls.filter((c) => c.path.endsWith("/signin")).length;
    assert.strictEqual(signins, 2, "401 后应重新登录一次");
  });
});

test("setCover：缺 id / 缺文件 → 立即抛错（不产生半截请求）", async () => {
  await assert.rejects(() => gc.setCover(null, "x.jpg"), (e) => e.code === "COVER_NO_ID");
  await assert.rejects(() => gc.setCover(1, "不存在的文件.jpg"), (e) => e.code === "COVER_NO_FILE");
});
