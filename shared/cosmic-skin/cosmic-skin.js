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
  window.addEventListener('resize', function () {
    rs();
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x0 > W) pts[i].x0 = Math.random() * W;
      if (pts[i].y0 > H) pts[i].y0 = Math.random() * H;
    }
  });
  for (var i = 0; i < 420; i++) {
    var rnd = Math.random();
    var starC = rnd < 0.62 ? '121,101,193'
      : rnd < 0.82 ? '72,58,160'
      : rnd < 0.95 ? '227,208,149'
      : '255,255,255';
    pts.push({
      x0: Math.random() * W, y0: Math.random() * H,
      r: Math.random() * 2.2 + 0.5,
      t: Math.random() * 6.28, s: Math.random() * 0.02 + 0.005,
      seed: Math.random() * 6.28,
      amp: 8 + Math.random() * 26,
      c: starC
    });
  }
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      p.t += p.s;
      var px = p.x0 + Math.sin(p.t * 0.7 + p.seed) * p.amp;
      var py = p.y0 + Math.cos(p.t * 0.5 + p.seed * 1.7) * p.amp * 0.7;
      ctx.beginPath();
      ctx.arc(px, py, p.r, 0, 7);
      ctx.fillStyle = 'rgba(' + p.c + ',' + (0.42 + Math.abs(Math.sin(p.t)) * 0.58) + ')';
      ctx.fill();
    }
    requestAnimationFrame(tick);
  })();
})();
