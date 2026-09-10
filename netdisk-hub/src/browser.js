// 统一浏览器启动器：优先用「系统自带 Microsoft Edge」，找不到再回退随包/本地的 Playwright Chromium。
//
// 背景：安装包原先内置 Playwright Chromium 内核（未压缩约 700MB，是 370MB 安装包的最大头）。
// Win10/11 均自带 Edge，改用系统浏览器后安装包可瘦身到约 120MB，更新下载量随之大幅下降；
// 同时登录窗口跑在用户熟悉的系统浏览器里，行为更接近真实环境。
//
// 兼容：两套引擎都尝试，任一成功即返回；都失败时抛出可读错误（含两个引擎各自的失败原因），
// 由登录流程把消息透传到前端「授权」弹窗，而不是只报一句 "Executable doesn't exist"。
const ENGINES = [
  {
    name: "msedge",
    label: "系统 Edge",
    // 关掉首次启动引导/默认浏览器检查：登录窗口是临时 profile，避免用户被 Edge 的欢迎页拦住
    options: {
      channel: "msedge",
      args: ["--no-first-run", "--no-default-browser-check"],
    },
  },
  { name: "chromium", label: "内置 Chromium", options: {} },
];

function playwright() {
  return require("playwright");
}

function firstLine(e) {
  return String((e && e.message) || e || "")
    .split("\n")[0]
    .slice(0, 160);
}

/** 启动独立浏览器实例（登录用），返回 { browser, engine }。 */
async function launchBrowser(opts = {}) {
  const { chromium } = playwright();
  const tried = [];
  for (const e of ENGINES) {
    try {
      const browser = await chromium.launch({ ...e.options, ...opts });
      return { browser, engine: e.name };
    } catch (err) {
      tried.push(e.label + "：" + firstLine(err));
    }
  }
  throw new Error(
    "无法启动浏览器（已尝试 " + tried.join("；") + "）。请确认系统已安装 Microsoft Edge。",
  );
}

/** 启动持久化上下文（迅雷保持登录用；会把 cookie 写进 userDataDir），返回 { context, engine }。 */
async function launchPersistentContext(userDataDir, opts = {}) {
  const { chromium } = playwright();
  const tried = [];
  for (const e of ENGINES) {
    try {
      const context = await chromium.launchPersistentContext(userDataDir, {
        ...e.options,
        ...opts,
      });
      return { context, engine: e.name };
    } catch (err) {
      tried.push(e.label + "：" + firstLine(err));
    }
  }
  throw new Error(
    "无法启动浏览器（已尝试 " + tried.join("；") + "）。请确认系统已安装 Microsoft Edge。",
  );
}

module.exports = { launchBrowser, launchPersistentContext };
