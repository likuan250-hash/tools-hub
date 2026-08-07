// 百度网盘登录:用 Playwright 在本机启动 headed Chromium 打开 pan.baidu.com,
// 等待用户登录(扫码/账号密码),登录后抓取完整 Cookie 存到 store。
// 因为百度「生成我的分享链接」与「带密码分享的列表」必须走网页端 BDUSS 会话,
// OAuth 的 access_token 不够用(实测 xpan/share?method=create 直接 404)。
//
// 关键:BDUSS 是 HttpOnly 登录态 Cookie,document.cookie 读不到,
// 必须用 context.cookies() 轮询。BAIDUID 是匿名标识,不能作为登录判据,只认 BDUSS。
const { chromium } = require('playwright');
const store = require('./store');
const { verifyCookie } = require('./baidu');

// 登录会话状态(供前端轮询)
let state = { status: 'idle', message: '', ts: 0 };

function setState(s, m) {
  state = { status: s, message: m || '', ts: Date.now() };
  return state;
}

function getState() {
  return state;
}

// 只认真正的登录态 Cookie BDUSS / BDUSS_BFESS(HttpOnly,页面内不可见)。
// 新设备登录常只下发 BDUSS_BFESS(pan.baidu.com 域 secure 会话),故两者都认。
const LOGIN_COOKIE_NAMES = ['BDUSS', 'BDUSS_BFESS'];

function hasLoginCookie(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  return LOGIN_COOKIE_NAMES.some((n) => names.has(n));
}

// 启动一次登录会话(异步,不阻塞请求)
async function startLogin() {
  setState('waiting', '请在弹出的百度网盘窗口中登录(扫码或账号密码)');
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://pan.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 轮询 context.cookies() 检测登录态(HttpOnly Cookie 只能这么读)
    const deadline = Date.now() + 300000; // 5 分钟
    let loggedIn = false;
    let finalCookies = null;
    while (Date.now() < deadline) {
      try {
        const cookies = await context.cookies();
        if (hasLoginCookie(cookies)) {
          loggedIn = true;
          finalCookies = cookies; // 检测到立即抓下,避免后续浏览器被关导致丢失
          break;
        }
      } catch (_) {
        // 浏览器可能被用户关闭:最后再尝试抓一次刚登录的会话
        try {
          const last = await context.cookies();
          if (hasLoginCookie(last)) { loggedIn = true; finalCookies = last; break; }
        } catch (__) {}
        break; // 上下文已不可用,停止轮询
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!loggedIn) throw new Error('未检测到登录态(请确认已扫码并在手机上点"登录",登录成功后再关闭浏览器窗口)');

    const cookies = finalCookies || await context.cookies();
    // 过滤 Playwright 偶尔抓到的脏 cookie(name 为空或 value 为 undefined 字符串),
    // 这种脏片段会导致百度解析 Cookie 头失败而返回 errno:-6。
    const cookieStr = cookies
      .filter((c) => c.name && String(c.value) !== 'undefined')
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    if (!cookieStr) throw new Error('未读取到任何有效 Cookie');

    // 真实验证:百度新设备常需额外短信/安全验证,仅 BDUSS 出现≠真正登录成功。
    // 直接拿抓到的 cookie 打一次真实接口,能拿到 bdstoken 才保存,避免假"已连接"+"errno=-6"。
    const verify = await verifyCookie(cookieStr);
    if (verify.ok && verify.minimal) {
      console.warn('[baidu.auth] 本次登录会话靠「仅核心 cookie」模式才通过验证(完整 cookie 被百度判异常),已正常保存');
    }
    if (!verify.ok) {
      // 校验不过:清空旧 cookie,让卡片显示"未连接"并提示重新授权,而不是保留无效登录态
      store.saveAccount('baidu', { connected: false, cookie: null, loginAt: null });
      setState('error', '百度登录未真正生效(errno=' + verify.errno + ')。请重新点「授权百度网盘」,在弹出的百度窗口内完成扫码并确认登录;若百度要求短信/安全验证请一并完成,等看到网盘文件列表后再关闭窗口。');
      return state;
    }

    // 合并写入,不覆盖已有的 OAuth token/refreshToken
    const save = {
      cookie: cookieStr,
      connected: true,
      loginAt: new Date().toISOString(),
    };
    // 登录态剩余天数：抓取 BDUSS 的真实过期时间（秒 → ms），无 expires（会话 cookie）则不写
    const loginCookie = cookies.find((c) => LOGIN_COOKIE_NAMES.includes(c.name)
      && typeof c.expires === 'number' && c.expires > 0);
    if (loginCookie) save.expiresAt = loginCookie.expires * 1000;
    store.saveAccount('baidu', save);
    setState('done', '百度网盘已连接(BDUSS 已保存且会话验证通过)');
  } catch (e) {
    setState('error', '登录超时或失败: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return state;
}

module.exports = { startLogin, getState };
