// quark.js HTTP 接口层测试（全局 fetch mock）
// 覆盖：getStoken、getDetail 翻页、saveShare、createShare(同步链接 + 异步轮询按 fid_list 匹配)、
//       transfer 编排、parseLink。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-quark-test-'));
process.env.NETDISK_DATA_DIR = TMP;
process.env.NETDISK_KEY_FILE = path.join(TMP, '.masterkey');

const store = require('../src/store');
const quark = require('../src/quark');

function makeFetch(router) {
  return async (url, opts) => {
    const arr = router(url, opts) || [{}, 200, {}];
    const body = arr[0] !== undefined ? arr[0] : {};
    const status = arr[1] !== undefined ? arr[1] : 200;
    const headers = arr[2] || {};
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Map(Object.entries(headers)),
      async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
      async text() { return text; },
    };
  };
}

let restoreFetch = null;
before(() => { const orig = global.fetch; restoreFetch = () => { global.fetch = orig; }; });
after(() => { if (restoreFetch) restoreFetch(); });

test('parseLink：从链接提取 pwdId 与 passcode', () => {
  assert.deepStrictEqual(quark.parseLink('https://pan.quark.cn/s/AbC123'), { pwdId: 'AbC123', passcode: '' });
  assert.deepStrictEqual(quark.parseLink('https://pan.quark.cn/s/XyZ?pwd=7788'), { pwdId: 'XyZ', passcode: '7788' });
  assert.deepStrictEqual(quark.parseLink('rawcode'), { pwdId: 'rawcode', passcode: '' });
});

test('getStoken：code 0 返回 stoken', async () => {
  global.fetch = makeFetch(() => [{ code: 0, data: { stoken: 'STOKEN1' } }]);
  const s = await quark.getStoken('cookie', 'pwdId', '');
  assert.strictEqual(s, 'STOKEN1');
});

test('getStoken：code 非 0 抛错', async () => {
  global.fetch = makeFetch(() => [{ code: 110000, message: 'invalid' }]);
  await assert.rejects(() => quark.getStoken('cookie', 'pwdId', ''), /获取分享凭证失败/);
});

test('getDetail：单页正确解析文件列表', async () => {
  global.fetch = makeFetch(() => [{
    code: 0,
    data: { list: [{ fid: 'f1', share_fid_token: 't1', file_name: 'a.iso', size: 100, dir: false }] },
  }]);
  const list = await quark.getDetail('cookie', 'pwdId', 'st');
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0], { fid: 'f1', share_fid_token: 't1', file_name: 'a.iso', size: 100, dir: false });
});

test('getDetail：多页自动翻页（50+10）', async () => {
  let page = 0;
  global.fetch = makeFetch(() => {
    page++;
    if (page === 1) {
      const list = Array.from({ length: 50 }, (_, i) => ({ fid: 'f' + i, file_name: 'n' + i, size: 1, dir: false }));
      return [{ code: 0, data: { list } }];
    }
    const list = Array.from({ length: 10 }, (_, i) => ({ fid: 'g' + i, file_name: 'm' + i, size: 1, dir: false }));
    return [{ code: 0, data: { list } }];
  });
  const list = await quark.getDetail('cookie', 'pwdId', 'st');
  assert.strictEqual(list.length, 60, '应合并两页 50 + 10');
});

test('saveShare：返回 task_id', async () => {
  global.fetch = makeFetch(() => [{ code: 0, data: { task_id: 'K1' } }]);
  const r = await quark.saveShare('cookie', { pwdId: 'p', stoken: 's', fidList: ['f1'], fidTokenList: ['t1'], toPdirFid: 'd' });
  assert.strictEqual(r.task_id, 'K1');
});

test('createShare：同步返回 share_url 直接出链', async () => {
  global.fetch = makeFetch((url) => {
    if (url.includes('/share/mypage/detail')) return [{}, 200, {}];
    return [{ code: 0, data: { share_url: 'https://pan.quark.cn/s/Abcde', passcode: '' } }];
  });
  const r = await quark.createShare('cookie', ['f1'], 0, '');
  assert.strictEqual(r.link, 'https://pan.quark.cn/s/Abcde');
  assert.strictEqual(r.password, '');
});

test('createShare：异步（仅 task_id）轮询后按 fid_list 精确匹配我的分享', async () => {
  global.fetch = makeFetch((url) => {
    if (url.includes('/share?') && true) {
      // createShare 的 POST /share 返回仅 task_id
      return [{ code: 0, data: { task_id: 'K9' } }];
    }
    if (url.includes('/task')) return [{ code: 0, data: { status: 2 } }]; // pollTask 成功
    if (url.includes('/share/mypage/detail')) {
      // getMyShareList：含一条匹配 fid_list ['f1'] 的分享
      return [{ code: 0, data: { list: [
        { share_id: 'other', share_url: 'https://pan.quark.cn/s/NoMatch', fid_list: ['zzz'] },
        { share_id: 'SH1', share_url: 'https://pan.quark.cn/s/Match01', fid_list: ['f1'], passcode: 'p1' },
      ] } }];
    }
    return [{}, 200, {}];
  });
  const r = await quark.createShare('cookie', ['f1'], 0, '');
  assert.strictEqual(r.link, 'https://pan.quark.cn/s/Match01', '应匹配到含 fid_list f1 的分享而非 list[0]');
  assert.strictEqual(r.password, 'p1');
});

test('createShare：异步但未返回任何链接抛错', async () => {
  global.fetch = makeFetch((url) => {
    if (url.includes('/share?')) return [{ code: 0, data: { task_id: 'K9' } }];
    if (url.includes('/task')) return [{ code: 0, data: { status: 2 } }];
    if (url.includes('/share/mypage/detail')) return [{ code: 0, data: { list: [] } }]; // 始终空
    return [{}, 200, {}];
  });
  await assert.rejects(() => quark.createShare('cookie', ['f1'], 0, ''), /生成分享成功但未返回链接/);
});

test('transfer：完整编排（无分享）', async () => {
  store.saveAccount('quark', { cookie: 'ck', connected: true });
  let ensured = false;
  global.fetch = makeFetch((url, opts) => {
    if (url.includes('/share/sharepage/token')) return [{ code: 0, data: { stoken: 'S' } }];
    if (url.includes('/share/sharepage/detail')) {
      return [{ code: 0, data: { list: [{ fid: 'f1', share_fid_token: 't1', file_name: 'a.iso', size: 9, dir: false }] } }];
    }
    if (url.includes('/share/sharepage/save')) return [{ code: 0, data: { task_id: 'K1' } }];
    if (url.includes('/task')) return [{ code: 0, data: { status: 2 } }];
    if (url.includes('/file?') && opts && opts.method === 'POST') { ensured = true; return [{ code: 0, data: { fid: 'DEST1' } }]; }
    return [{}, 200, {}];
  });
  const r = await quark.transfer({ cookie: 'ck', pwdId: 'p', passcode: '', makeShare: false });
  assert.strictEqual(ensured, true, '应确保目标文件夹存在');
  assert.strictEqual(r.file_list.length, 1);
  assert.strictEqual(r.file_list[0].server_filename, 'a.iso');
  assert.strictEqual(r.task_id, 'K1');
  assert.strictEqual(r.share, null, '不生成分享时 share 为 null');
});

test('transfer：生成分享时列出目标目录并按名匹配新文件', async () => {
  store.saveAccount('quark', { cookie: 'ck', connected: true });
  global.fetch = makeFetch((url, opts) => {
    if (url.includes('/share/sharepage/token')) return [{ code: 0, data: { stoken: 'S' } }];
    if (url.includes('/share/sharepage/detail')) {
      return [{ code: 0, data: { list: [{ fid: 'f1', share_fid_token: 't1', file_name: 'a.iso', size: 9, dir: false }] } }];
    }
    if (url.includes('/share/sharepage/save')) return [{ code: 0, data: { task_id: 'K1' } }];
    if (url.includes('/task')) return [{ code: 0, data: { status: 2 } }];
    if (url.includes('/file?') && opts && opts.method === 'POST') return [{ code: 0, data: { fid: 'DEST1' } }];
    if (url.includes('/file/sort')) return [{ code: 0, data: { list: [{ fid: 'f1', file_name: 'a.iso' }] } }]; // listFolder
    if (url.includes('/share?') && opts && opts.method === 'POST') {
      return [{ code: 0, data: { share_url: 'https://pan.quark.cn/s/Share01', passcode: '' } }];
    }
    return [{}, 200, {}];
  });
  const r = await quark.transfer({ cookie: 'ck', pwdId: 'p', passcode: '', makeShare: true, sharePeriod: 0, sharePassword: '' });
  assert.ok(r.share, '应生成分享');
  assert.strictEqual(r.share.link, 'https://pan.quark.cn/s/Share01');
  assert.strictEqual(r.destPath, '/netdisk_hub');
});
