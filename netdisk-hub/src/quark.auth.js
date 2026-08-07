// 夸克网盘登录:用 Playwright 在本机启动 headed Chromium 打开 pan.quark.cn,
// 等待用户登录(扫码/账号密码),登录后抓取 Cookie 存到 store。
// 因为夸克没有官方 OAuth,这是"无官方应用"情况下的登录方式。
//
// 关键:__pus / kpsession-id 等登录态 Cookie 是 HttpOnly,
// document.cookie 读不到,必须用 context.cookies() 轮询。
const { chromium } = require('playwright');
const store = require('./store');

// 登录会话状态(供前端轮询)
let state = { status: 'idle', message: '', ts: 0 };

function setState(s, m) {
  state = { status: s, message: m || '', ts: Date.now() };
  return state;
}

function getState() {
  return state;
}

// 登录态判定:HttpOnly Cookie 在 document.cookie 不可见,
// 必须通过 context.cookies() 读取。
// 只认真正的会话 Cookie(__pus / kpsession-id)。
// 注意 b-user-id 是匿名标识,未登录首页就会 set,不能作为登录判据。
const LOGIN_COOKIE_NAMES = ['__pus', 'kpsession-id'];

function hasLoginCookie(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return LOGIN_COOKIE_NAMES.some((n) => names.has(n));
}

// 启动一次登录会话(异步,不阻塞请求)
async function startLogin() {
  setState('waiting', '请在弹出的夸克网盘窗口中登录(手机 App 扫码或账号密码)');
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://pan.quark.cn/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 轮询 context.cookies() 检测登录态(HttpOnly Cookie 只能这么读)
    const deadline = Date.now() + 300000; // 5 分钟
    let loggedIn = false;
    while (Date.now() < deadline) {
      try {
        const cookies = await context.cookies();
        if (hasLoginCookie(cookies)) {
          loggedIn = true;
          break;
        }
      } catch (_) {
        // 浏览器上下文可能临时不可用,忽略继续轮询
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!loggedIn) throw new Error('5 分钟内未检测到登录态,请重试');

    const cookies = await context.cookies();
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (!cookieStr) throw new Error('未读取到任何 Cookie');

    const save = {
      cookie: cookieStr,
      connected: true,
      loginAt: new Date().toISOString(),
    };
    // 登录态剩余天数：抓取 __pus/kpsession-id 的真实过期时间（秒 → ms），无 expires 则不写
    const loginCookie = cookies.find((c) => LOGIN_COOKIE_NAMES.includes(c.name)
      && typeof c.expires === 'number' && c.expires > 0);
    if (loginCookie) save.expiresAt = loginCookie.expires * 1000;
    store.saveAccount('quark', save);
    setState('done', '夸克网盘已连接,Cookie 已保存');
  } catch (e) {
    setState('error', '登录超时或失败: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return state;
}

module.exports = { startLogin, getState };
