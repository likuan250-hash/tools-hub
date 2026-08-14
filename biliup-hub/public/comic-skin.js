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
})();
