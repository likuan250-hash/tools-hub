// shared/comic-skin/comic-skin.js —— 漫画皮肤装饰：角落拟声词
// 自动注入两个 fixed 拟声词（ドン!! / ポン!!），仅 html[data-skin="comic"] 时 CSS 显示；
// 动效全开，不随 prefers-reduced-motion 降级（与 cosmic 一致）。
(function () {
  // 拟声词装饰：防重复注入（脚本被二次执行时不叠加）
  if (!document.querySelector(".comic-sfx")) {
    var d1 = document.createElement("div");
    d1.className = "comic-sfx c1";
    d1.textContent = "ドン!!";
    d1.style.setProperty("--r", "-7deg");
    d1.style.right = "28px";
    d1.style.bottom = "24px";
    d1.style.fontSize = "42px";
    document.body.appendChild(d1);

    var d2 = document.createElement("div");
    d2.className = "comic-sfx c2";
    d2.textContent = "ポン!!";
    d2.style.setProperty("--r", "6deg");
    d2.style.left = "24px";
    d2.style.bottom = "96px";
    d2.style.fontSize = "26px";
    document.body.appendChild(d2);
  }

  // 执行进度条随机漫画变体（A 锯齿能量 / B 分格能量槽+星星 / C 气泡进度）
  // 步骤内进度条统一为真实轨道元素 .cp-track（注入 .step-body，填充条为其子元素，
  // 由轨道 overflow 裁剪，保证任何框宽下都不变形不偏移）
  var PROG = ".exec-bar, .bili-exec-bar, .step-indeterminate, .step-item";
  var CLASSES = ["cp-a", "cp-b", "cp-c"];
  function decorate(el) {
    if (el.dataset.cp) return;
    el.dataset.cp = "1";
    var cls = CLASSES[(Math.random() * CLASSES.length) | 0];
    el.classList.add(cls);
    if (el.classList.contains("step-item")) {
      refreshStep(el);
    } else {
      if (cls === "cp-b") {
        addSeg(el);
        driveB(el);
      }
      if (cls === "cp-c") {
        addBubble(el);
        driveBubble(el);
      }
    }
  }
  // 步骤是否处于执行中（只给执行中的步骤显示进度条）
  function isRunningStep(el) {
    return el.classList.contains("info") || !!el.querySelector(".st-luxe--info");
  }
  // 进度条动画是否还应继续：步骤完成（非执行中）或独立条被隐藏时自停，避免常驻 rAF 空转烧 CPU
  function keepLoopRunning(el) {
    if (!el || !el.isConnected) return false;
    if (el.classList.contains("step-item")) return isRunningStep(el);
    return getComputedStyle(el).display !== "none";
  }
  // 步骤内进度条的宿主：step-item → .step-body 内的 .cp-track；独立进度条 → 元素自身
  function trackHost(el) {
    if (el.classList.contains("step-item")) {
      var body = el.querySelector(".step-body");
      if (!body) return null;
      return body.querySelector(".cp-track") || null;
    }
    return el;
  }
  // 注入真实轨道（幂等）；步骤重渲染（innerHTML 重写）后由 refreshStep 重新补齐
  function ensureTrack(el) {
    var body = el.querySelector(".step-body");
    if (!body || body.querySelector(".cp-track")) return;
    var t = document.createElement("div");
    t.className = "cp-track";
    body.appendChild(t);
  }
  // 步骤内容被重渲染后恢复进度条结构（轨道/格子/星星/气泡）
  function refreshStep(el) {
    if (!el || el.id === "execStep" || !el.classList.contains("step-item")) return;
    if (!isRunningStep(el)) return;
    ensureTrack(el);
    if (el.classList.contains("cp-b")) {
      addSeg(el);
      el.dataset.cpB = "";
      driveB(el);
    } else if (el.classList.contains("cp-c")) {
      addBubble(el);
      el.dataset.cpC = "";
      driveBubble(el);
    }
  }
  // B 变体：注入分格能量槽（32 格），格子随星星扫过逐个点亮/熄灭
  function addSeg(el) {
    if (el.querySelector(".cp-seg")) return;
    var host = trackHost(el);
    if (!host) return;
    var seg = document.createElement("div");
    seg.className = "cp-seg";
    var N = 32;
    for (var i = 0; i < N; i += 1) {
      var cell = document.createElement("i");
      cell.style.animationDelay = ((i * 0.7) / N).toFixed(3) + "s";
      seg.appendChild(cell);
    }
    host.appendChild(seg);
  }
  // B 变体：JS 驱动星星 + 格子完全同步（CSS 动画各自独立会节奏错位）
  function driveB(el) {
    var host = trackHost(el);
    if (!host) return;
    var seg = host.querySelector(".cp-seg");
    if (!seg) return;
    var cells = seg.children;
    var N = cells.length;
    if (!N) return;
    var star = host.querySelector(".cp-star");
    if (!star) {
      star = document.createElement("span");
      star.className = "cp-star";
      star.textContent = "★";
      host.appendChild(star);
    }
    if (el.dataset.cpB) return;
    el.dataset.cpB = "1";
    el.classList.add("cp-js");
    var dur = 1400; // 单程 700ms，往返 1400ms
    var t0 = null;
    function frame(now) {
      if (!keepLoopRunning(el) || !star.isConnected) return; // 重渲染/步骤完成/隐藏后自停
      if (t0 === null) t0 = now;
      var p = ((now - t0) % (dur * 2)) / dur; // 0..2
      var f = p <= 1 ? p : 2 - p; // 往返 0..1..0
      // 星星活动范围 = 轨道宽度（步骤内为 220px 轨道，独立进度条为轨道全宽）
      var w = seg.clientWidth || host.clientWidth || 200;
      var sw = star.offsetWidth || 20;
      star.style.left = Math.max(0, f * (w - sw - 2)) + "px";
      var lit = Math.round(f * N);
      for (var i = 0; i < N; i += 1) {
        if (cells[i].classList.contains("lit") !== i < lit)
          cells[i].classList.toggle("lit", i < lit);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  // C 变体：步骤内进度条补注入「加载中…」气泡（与独立进度条一致；step-body 伪元素已占满）
  function addBubble(el) {
    var host = trackHost(el);
    if (!host || host.querySelector(".cp-bubble")) return;
    var bub = document.createElement("span");
    bub.className = "cp-bubble";
    bub.textContent = "加载中…";
    host.appendChild(bub);
  }
  // C 变体：步骤内气泡也用 JS 驱动，范围对齐 220px 轨道（CSS left 百分比相对 step-body 全宽会跑偏）
  function driveBubble(el) {
    var host = trackHost(el);
    var bub = host && host.querySelector(".cp-bubble");
    if (!bub) return;
    if (el.dataset.cpC) return;
    el.dataset.cpC = "1";
    bub.style.animation = "none";
    var dur = 1300;
    var t0 = null;
    function frame(now) {
      if (!keepLoopRunning(el) || !bub.isConnected) return;
      if (t0 === null) t0 = now;
      var p = ((now - t0) % (dur * 2)) / dur;
      var f = p <= 1 ? p : 2 - p;
      var w = host.clientWidth || 200;
      var sw = bub.offsetWidth || 50;
      bub.style.left = Math.max(0, f * (w - sw - 2)) + "px";
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
        // 步骤整体重写 innerHTML 时，补一次结构恢复（轨道/格子/星星/气泡）
        var t = muts[i].target;
        if (t && t.nodeType === 1 && t.classList && t.classList.contains("step-item")) {
          refreshStep(t);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
