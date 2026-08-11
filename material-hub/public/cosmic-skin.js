// shared/cosmic-skin/cosmic-skin.js —— 宇宙皮肤装饰：星空 canvas
// 自动注入 #cosmicStars 画布（仅 html[data-skin="cosmic"] 时 CSS 显示）；
// 动效全开，不随 prefers-reduced-motion 降级。
(function () {
  var cv = document.createElement('canvas');
  cv.id = 'cosmicStars';
  document.body.insertBefore(cv, document.body.firstChild);
  var ctx = cv.getContext('2d');
  var W = 0, H = 0, pts = [];
  function rs() { W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
  rs();
  window.addEventListener('resize', rs);
  for (var i = 0; i < 240; i++) {
    pts.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, t: Math.random() * 6.28, s: Math.random() * 0.02 + 0.005 });
  }
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      p.t += p.s;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 7);
      ctx.fillStyle = 'rgba(94,242,255,' + (0.25 + Math.abs(Math.sin(p.t)) * 0.65) + ')';
      ctx.fill();
    }
    requestAnimationFrame(tick);
  })();
})();
