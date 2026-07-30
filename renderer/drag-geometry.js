// drag-geometry.js — 拖拽插入位置的纯几何计算（DOM 无关，便于单测）
//
// 网格阅读顺序（与入口卡片布局一致）：上排优先、同排左优先。
// rects: 兄弟卡片的矩形数组，元素为 { left, top, width, height }（相对视口）。
// 返回：应插入到 rects 的哪个下标（0..rects.length）。
function computeInsertIndex(rects, px, py) {
  let idx = rects.length;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    // 指针明显在更靠上的行 → 插入到该行卡片之前
    if (py < cy - r.height / 2) { idx = i; break; }
    // 与卡片同行（垂直落在卡片高度范围内）且指针在其水平中心左侧 → 插入其前
    if (Math.abs(py - cy) <= r.height / 2 && px < cx) { idx = i; break; }
  }
  return idx;
}

// 双上下文导出：
//  - 浏览器：以 <script> 注入到 window（渲染进程关闭 nodeIntegration，不能用 require）。
//  - Node（单测 / require）：走 module.exports，保持 renderer/test/drag-geometry.test.js 可用。
// 两种方式互不污染，且都不会在对方环境变量缺失时抛错。
if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeInsertIndex };
}
if (typeof window !== "undefined") {
  window.computeInsertIndex = computeInsertIndex;
}
