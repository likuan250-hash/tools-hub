// shared/comic-skin/comic-skin.js —— 漫画皮肤装饰：角落拟声词
// 自动注入两个 fixed 拟声词（ドン!! / ポン!!），仅 html[data-skin="comic"] 时 CSS 显示；
// 动效全开，不随 prefers-reduced-motion 降级（与 cosmic 一致）。
(function () {
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

  // 执行进度条随机漫画变体（A 锯齿能量 / B 分格能量槽+星星 / C 气泡进度）
  var PROG = '.exec-bar, .bili-exec-bar, .step-indeterminate';
  var CLASSES = ['cp-a', 'cp-b', 'cp-c'];
  function decorate(el) {
    if (el.dataset.cp) return;
    el.dataset.cp = '1';
    el.classList.add(CLASSES[(Math.random() * CLASSES.length) | 0]);
  }
  function scan(root) {
    var els = (root || document).querySelectorAll(PROG);
    for (var i = 0; i < els.length; i += 1) decorate(els[i]);
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
