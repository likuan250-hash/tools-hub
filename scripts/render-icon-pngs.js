// 用 Playwright(Chromium) 把 SVG 图标栅格化成多尺寸 PNG，供 build-multi-icon.js 打包 ICO。
// 用法：node scripts/render-icon-pngs.js
// 输入：build/icon-source.svg   输出：build/.icon-render/icon-{size}.png
// 注意：必须用 canvas 光栅化（drawImage），不能截 DOM 截图——Chromium 对大体量
// evenodd 路径的 DOM 绘制有 bug，大尺寸下会在图形左侧渲染出黑色伪影；canvas
// 光栅化（与设计工具一致）无此问题。
const fs = require('fs');
const path = require('path');
const { chromium } = require('../netdisk-hub/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-source.svg');
const OUT = path.join(ROOT, 'build', '.icon-render');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(SRC)) throw new Error('缺少 ' + SRC);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const svg = fs.readFileSync(SRC, 'utf8');
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    for (const s of SIZES) {
      await page.setViewportSize({ width: s, height: s });
      await page.setContent('<html><body style="margin:0"><canvas id="c"></canvas></body></html>');
      const dataUrlPng = await page.evaluate(async ({ dataUrl, s }) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.getElementById('c');
        c.width = s; c.height = s;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, s, s);
        return c.toDataURL('image/png');
      }, { dataUrl, s });
      const buf = Buffer.from(dataUrlPng.split(',')[1], 'base64');
      const fp = path.join(OUT, 'icon-' + s + '.png');
      fs.writeFileSync(fp, buf);
      console.log('rendered', s + 'px ->', fp);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
