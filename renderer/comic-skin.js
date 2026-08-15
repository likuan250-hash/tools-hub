// shared/comic-skin/comic-skin.js —— 漫画皮肤装饰：角落拟声词
// 自动注入两个 fixed 拟声词（ドン!! / ポン!!），仅 html[data-skin="comic"] 时 CSS 显示；
// 动效全开，不随 prefers-reduced-motion 降级（与 cosmic 一致）。
(function () {
  // 拟声词装饰：防重复注入（脚本被二次执行时不叠加）
  if (!document.querySelector('.comic-sfx')) {
    var d1 = document.createElement('div');
    d1.className = 'comic-sfx c1';
    d1.textContent = 'ドン!!';
    d1.style.setProperty('--r', '-7deg');
    d1.style.right = '28px';
    d1.style.bottom = '24px';
    d1.style.fontSize = '42px';
    document.body.appendChild(d1);

    var d2 = document.createElement('div');
    d2.className = 'comic-sfx c2';
    d2.textContent = 'ポン!!';
    d2.style.setProperty('--r', '6deg');
    d2.style.left = '24px';
    d2.style.bottom = '96px';
    d2.style.fontSize = '26px';
    document.body.appendChild(d2);
  }

  // 执行进度条随机漫画变体（A 锯齿能量 / B 分格能量槽+星星 / C 气泡进度）
  // .step-item 覆盖 kdocs/netdisk 的 step-body 细进度条（cp 类作用于其内部伪元素条）
  var PROG = '.exec-bar, .bili-exec-bar, .step-indeterminate, .step-item';
  var CLASSES = ['cp-a', 'cp-b', 'cp-c'];
  function decorate(el) {
    if (el.dataset.cp) return;
    el.dataset.cp = '1';
    var cls = CLASSES[(Math.random() * CLASSES.length) | 0];
    el.classList.add(cls);
    if (cls === 'cp-b') { addSeg(el); driveB(el); }
  }
  // B 变体：注入分格能量槽（32 格），格子随星星扫过逐个点亮/熄灭
  function addSeg(el) {
    if (el.querySelector('.cp-seg')) return;
    // 步骤内进度条（kdocs/netdisk）：格子注入 .step-body 的底部轨道区域；独立进度条直接铺满
    var host = el.classList.contains('step-item') ? el.querySelector('.step-body') : el;
    if (!host) return;
    var seg = document.createElement('div');
    seg.className = 'cp-seg';
    var N = 32;
    for (var i = 0; i < N; i += 1) {
      var cell = document.createElement('i');
      cell.style.animationDelay = (i * 0.7 / N).toFixed(3) + 's';
      seg.appendChild(cell);
    }
    host.appendChild(seg);
  }
  // B 变体：JS 驱动星星 + 格子完全同步（CSS 动画各自独立会节奏错位）
  function driveB(el) {
    if (el.dataset.cpB) return;
    el.dataset.cpB = '1';
    var host = el.classList.contains('step-item') ? el.querySelector('.step-body') : el;
    if (!host) return;
    el.classList.add('cp-js'); // 禁用 CSS 伪元素星星，改由 JS span 驱动
    var seg = host.querySelector('.cp-seg');
    if (!seg) return;
    var cells = seg.children;
    var N = cells.length;
    if (!N) return;
    var star = document.createElement('span');
    star.className = 'cp-star';
    star.textContent = '★';
    host.appendChild(star);
    var dur = 1400; // 单程 700ms，往返 1400ms
    var t0 = null;
    function frame(now) {
      if (t0 === null) t0 = now;
      var p = ((now - t0) % (dur * 2)) / dur; // 0..2
      var f = p <= 1 ? p : 2 - p;              // 往返 0..1..0
      var w = host.clientWidth || 200;
      var sw = star.offsetWidth || 20;
      star.style.left = Math.max(0, f * (w - sw - 2)) + 'px';
      var lit = Math.round(f * N);
      for (var i = 0; i < N; i += 1) {
        if (cells[i].classList.contains('lit') !== (i < lit)) cells[i].classList.toggle('lit', i < lit);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function scan(root) {
    var els = (root || document).querySelectorAll(PROG);
    for (var i = 0; i < els.length; i += 1) decorate(els[i]);
    // querySelectorAll 不含根元素自身：动态添加的元素（如素材收集的 step-item）需单独匹配
    if (root && root.nodeType === 1 && root.matches && root.matches(PROG)) decorate(root);
  }
  scan(document);
  if (window.MutationObserver) {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i += 1) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j += 1) {
          if (nodes[j].nodeType === 1) scan(nodes[j]);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
