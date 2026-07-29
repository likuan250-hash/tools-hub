// 迅雷网盘登录:用 Playwright 在本机启动 headed Chromium 打开 pan.xunlei.com,
// 等用户登录(扫码/账号密码)。登录态以 **浏览器 cookie** 形式持久化到 data/xunlei_profile,
// 后续所有迅雷操作(launchPersistentContext 复用该目录)即保持登录。
//
// 关键点:迅雷 web 端的鉴权就是浏览器 cookie —— 没有独立的 Bearer token 体系。
// 因此登录只需确认「出现了登录态 cookie」即可,无需拦截 token。
const { chromium } = require('playwright');
const path = require('path');
const store = require('./store');

// 登录态目录：同 store.js，优先 NETDISK_DATA_DIR(升级不丢)，否则回退安装目录 data/。
const STORAGE_DIR = path.join(
  process.env.NETDISK_DATA_DIR || path.join(__dirname, '..', 'data'),
  'xunlei_profile'
);
let state = { status: 'idle', message: '', ts: 0 };

function setState(s, m) {
  state = { status: s, message: m || '', ts: Date.now() };
  return state;
}
function getState() {
  return state;
}

// 判断 cookie 里是否已有登录态。
// 未登录时 xunlei 只有设备/指纹类 cookie: XLA_CI, deviceid, xl_fp_rt, xl_fp 等;
// 登录成功后会多出用户身份类 cookie(具体名不定,故采用「排除设备类后还有非空 cookie 即视为已登录」)。
function hasLoginCookie(cookies) {
  const xl = cookies.filter((c) => c.domain && c.domain.includes('xunlei'));
  const DEVICE_LIKE = /XLA_CI|deviceid|xl_fp/i;
  const loginCookies = xl.filter((c) => c.value && !DEVICE_LIKE.test(c.name));
  return loginCookies.length > 0;
}

async function startLogin() {
  setState('waiting', '请在弹出的迅雷网盘窗口中登录(手机 App 扫码或账号密码)');
  let context;
  try {
    // 用持久化 context:登录后 cookie 自动写入 data/xunlei_profile,后续 headless 复用
    context = await chromium.launchPersistentContext(STORAGE_DIR, { headless: false });
    const page = await context.newPage();
    await page.goto('https://pan.xunlei.com/', { waitUntil: 'domcontentloaded' });

    // 轮询 cookie:出现登录态即标记 connected。最长 600s 给用户充足时间。
    const ok = await new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(async () => {
        let cookies = [];
        try {
          cookies = await context.cookies();
        } catch (e) {}
        const xlNames = cookies.filter((c) => c.domain && c.domain.includes('xunlei')).map((c) => c.name).join(',');
        console.log('[xunlei-auth] xl cookies:', xlNames, '| hasLogin:', hasLoginCookie(cookies));
        if (hasLoginCookie(cookies)) {
          clearInterval(iv);
          return resolve(true);
        }
        if (Date.now() - t0 > 600000) {
          clearInterval(iv);
          return resolve(false);
        }
      }, 2000);
    });

    if (ok) {
      store.saveAccount('xunlei', {
        connected: true,
        loginAt: new Date().toISOString(),
        expiresAt: Date.now() + 90 * 24 * 3600 * 1000,
      });
      setState('done', '迅雷网盘已连接');
    } else {
      setState('error', '登录超时:未检测到登录态 Cookie,请重新点击授权并在弹窗中完成登录');
    }
  } catch (e) {
    setState('error', '登录失败: ' + e.message);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  return state;
}

module.exports = { startLogin, getState };
