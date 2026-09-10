// shared/gameboy-skin/gameboy-skin.js —— 掌机皮肤的两处「需要 JS」的部分：
//   ① 入口页：注入 Game Boy 机身；卡片当卡带，拖到机身的插卡口松手即打开工具
//   ② 子页面：给执行中的步骤注入点阵进度轨道（.gb-track，32 格），随步骤状态自停
// 约束：只在 html[data-skin="gameboy"] 时工作；入口逻辑要求页面存在 #landing（子页面自动跳过）；
//       幂等注入（脚本重复执行不叠加）；不依赖任何页面内部变量，通过现有 DOM（.card[data-key] /
//       .card-open / .step-body）操作，因此不会影响其他皮肤（其他皮肤下本脚本直接 return）。
(function () {
  var SKIN = "gameboy";

  function isSkinOn() {
    return document.documentElement.getAttribute("data-skin") === SKIN;
  }

  /* ─────────── ① 入口页：机身 + 插卡 ─────────── */
  var device = null;
  var screenMsg = null;
  var screenTitle = null;
  var screenSub = null;
  var slotEl = null;
  var ledDot = null;
  var dragging = null;
  var ghost = null;

  function buildDevice() {
    var landing = document.getElementById("landing");
    if (!landing || device) return;
    device = document.createElement("div");
    device.className = "gb-device";
    device.id = "gbDevice";
    device.innerHTML =
      '<div class="gb-screen-frame">' +
      '<div class="gb-screen-top">DOT MATRIX WITH STEREO SOUND</div>' +
      '<div class="gb-screen">' +
      '<div class="gb-screen-title">TOOLS HUB</div>' +
      '<div class="gb-screen-msg">▸ 初始化中…</div>' +
      '<div class="gb-screen-sub">DRAG A CARTRIDGE TO INSERT</div>' +
      '<div class="gb-led"><i></i> BATTERY</div>' +
      "</div></div>" +
      '<div class="gb-slot">INSERT CARTRIDGE</div>' +
      '<div class="gb-controls"><div class="gb-cross"></div>' +
      '<div class="gb-ab"><span class="b">B</span><span class="a">A</span></div></div>';
    landing.appendChild(device);
    screenTitle = device.querySelector(".gb-screen-title");
    screenMsg = device.querySelector(".gb-screen-msg");
    screenSub = device.querySelector(".gb-screen-sub");
    slotEl = device.querySelector(".gb-slot");
    ledDot = device.querySelector(".gb-led i");
    syncScreen();
  }

  /** 用顶部总状态（#aggStatus 内的小方块）刷新机身屏幕文案与电池灯。 */
  function syncScreen() {
    if (!device || !screenMsg) return;
    var agg = document.getElementById("aggStatus");
    var balls = agg ? agg.querySelectorAll(".dball") : [];
    var on = 0;
    for (var i = 0; i < balls.length; i += 1) if (balls[i].classList.contains("on")) on += 1;
    var total = balls.length;
    if (dragging) return; // 插卡动画期间不抢占屏幕
    if (!total) {
      screenMsg.textContent = "▸ " + ((agg && agg.textContent.trim()) || "状态未知");
      if (ledDot) ledDot.className = "off";
      return;
    }
    var allOn = on === total;
    screenMsg.textContent = allOn ? "▸ 全部在线 · ALL READY" : "▸ " + on + "/" + total + " 模块在线";
    screenSub.textContent = allOn ? "PRESS START TO RUN" : "部分模块离线，仍可使用";
    if (ledDot) ledDot.className = allOn ? "" : "off";
  }

  function cardLabel(card) {
    var t = card.querySelector(".card-title");
    return (t && t.textContent.trim()) || "工具";
  }

  function startDrag(card, x, y) {
    dragging = { card: card, key: card.dataset.key || "", name: cardLabel(card) };
    card.classList.add("dragging");
    ghost = document.createElement("div");
    ghost.className = "gb-ghost";
    ghost.innerHTML = '<div class="gb-ghost-label">' + dragging.name + "</div>";
    document.body.appendChild(ghost);
    moveGhost(x, y);
  }

  function moveGhost(x, y) {
    if (!ghost) return;
    ghost.style.left = x + "px";
    ghost.style.top = y + "px";
    if (slotEl) {
      var r = slotEl.getBoundingClientRect();
      var hot = x >= r.left && x <= r.right && y >= r.top - 30 && y <= r.bottom + 30;
      slotEl.classList.toggle("hot", hot);
    }
  }

  function endDrag(x, y) {
    if (!dragging) return;
    var card = dragging.card;
    var key = dragging.key;
    var name = dragging.name;
    card.classList.remove("dragging");
    var overSlot = false;
    if (slotEl) {
      var r = slotEl.getBoundingClientRect();
      overSlot = x >= r.left && x <= r.right && y >= r.top - 30 && y <= r.bottom + 30;
      slotEl.classList.remove("hot");
    }
    if (!overSlot) {
      if (ghost) ghost.remove();
      ghost = null;
      dragging = null;
      return;
    }
    insertAndOpen(card, key, name);
  }

  /** 插卡动画：卡带滑入插槽 → 屏幕显示 LOADING + 点阵 → 打开工具。 */
  function insertAndOpen(card, key, name) {
    if (slotEl) {
      var r = slotEl.getBoundingClientRect();
      ghost.style.left = r.left + r.width / 2 + "px";
      ghost.style.top = r.top + r.height / 2 + "px";
    }
    if (ghost) ghost.classList.add("inserting");
    if (screenTitle) screenTitle.textContent = "LOADING";
    if (screenMsg) screenMsg.textContent = "▸ " + name;
    if (screenSub) screenSub.textContent = "INSERTING CARTRIDGE…";
    var cells = buildScreenCells();
    var t0 = null;
    function frame(now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / 760);
      var lit = Math.round(p * cells.length);
      for (var i = 0; i < cells.length; i += 1) {
        cells[i].className = i < lit ? "on" : i === lit ? "head" : "";
      }
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        openCard(card);
      }
    }
    requestAnimationFrame(frame);
    setTimeout(function () {
      if (ghost) ghost.remove();
      ghost = null;
      dragging = null;
      resetScreen();
    }, 900);
  }

  function buildScreenCells() {
    if (!device) return [];
    var host = device.querySelector(".gb-screen-grid");
    if (!host) {
      host = document.createElement("div");
      host.className = "gb-track gb-screen-grid";
      host.style.marginTop = "10px";
      var screen = device.querySelector(".gb-screen");
      if (screen) screen.appendChild(host);
    }
    host.innerHTML = "";
    var cells = [];
    for (var i = 0; i < 32; i += 1) {
      var c = document.createElement("i");
      host.appendChild(c);
      cells.push(c);
    }
    return cells;
  }

  function resetScreen() {
    if (screenTitle) screenTitle.textContent = "TOOLS HUB";
    if (screenSub) screenSub.textContent = "DRAG A CARTRIDGE TO INSERT";
    syncScreen();
  }

  /** 打开工具：复用页面既有入口（卡片的「打开」按钮），不改动页面逻辑。 */
  function openCard(card) {
    var btn = card && card.querySelector(".card-open");
    if (btn) btn.click();
  }

  function bindCards() {
    var host = document.getElementById("toolCards");
    if (!host) return;
    host.querySelectorAll(".card").forEach(function (card) {
      if (card.dataset.gbBound) return;
      card.dataset.gbBound = "1";
      var start = null;
      card.addEventListener("pointerdown", function (e) {
        if (!isSkinOn()) return;
        if (host.classList.contains("sorting")) return; // 排序模式交给页面自身拖拽
        if (e.button !== 0) return;
        if (e.target.closest("button")) return;
        start = { x: e.clientX, y: e.clientY, id: e.pointerId };
        // 捕获指针：拖动过程中 pointermove/pointerup 仍派发到卡片本身，
        // 否则松手位置在机身上时事件落到机身，拖拽无法结束（实测坑）。
        try {
          card.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 某些环境不支持捕获时退化为普通事件流 */
        }
      });
      card.addEventListener("pointermove", function (e) {
        if (!start) return;
        if (!dragging) {
          if (Math.abs(e.clientX - start.x) < 6 && Math.abs(e.clientY - start.y) < 6) return;
          startDrag(card, e.clientX, e.clientY);
        }
        moveGhost(e.clientX, e.clientY);
      });
      card.addEventListener("pointerup", function (e) {
        if (!start) return;
        var wasDragging = !!dragging;
        start = null;
        if (wasDragging) endDrag(e.clientX, e.clientY);
      });
      card.addEventListener("pointercancel", function () {
        if (ghost) ghost.remove();
        ghost = null;
        dragging = null;
        start = null;
        card.classList.remove("dragging");
        if (slotEl) slotEl.classList.remove("hot");
      });
    });
  }

  /* ─────────── ② 子页面：点阵进度轨道 ─────────── */
  var PROG = ".step-item";

  function isRunningStep(el) {
    return el.classList.contains("info") || !!el.querySelector(".st-luxe--info");
  }

  function ensureTrack(el) {
    var body = el.querySelector(".step-body");
    if (!body || body.querySelector(".gb-track")) return null;
    var t = document.createElement("div");
    t.className = "gb-track";
    for (var i = 0; i < 32; i += 1) t.appendChild(document.createElement("i"));
    body.appendChild(t);
    return t;
  }

  /** 点阵扫描：亮格从左扫到右再扫回（与静态预览同款节奏），步骤结束即自停。 */
  function drive(el) {
    if (el.dataset.gbRun) return;
    el.dataset.gbRun = "1";
    var t0 = null;
    function frame(now) {
      if (!el.isConnected || !isRunningStep(el)) {
        el.dataset.gbRun = "";
        return;
      }
      var track = el.querySelector(".gb-track");
      if (!track) {
        el.dataset.gbRun = "";
        return;
      }
      var cells = track.children;
      var N = cells.length;
      if (!N) {
        el.dataset.gbRun = "";
        return;
      }
      if (t0 === null) t0 = now;
      var p = ((now - t0) % 1800) / 900; // 0..2
      var f = p <= 1 ? p : 2 - p; // 往返
      var head = Math.min(N - 1, Math.round(f * (N - 1)));
      for (var i = 0; i < N; i += 1) {
        var cls = i === head ? "head" : i < head ? "on" : "";
        if (cells[i].className !== cls) cells[i].className = cls;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function scan(root) {
    var els = (root || document).querySelectorAll(PROG);
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      if (!isRunningStep(el)) continue;
      ensureTrack(el);
      drive(el);
    }
    if (root && root.nodeType === 1 && root.matches && root.matches(PROG) && isRunningStep(root)) {
      ensureTrack(root);
      drive(root);
    }
  }

  function boot() {
    if (!isSkinOn()) return;
    buildDevice();
    bindCards();
    syncScreen();
    scan(document);
  }

  boot();

  // 皮肤切换 / 卡片重渲染 / 步骤新增：统一重跑（幂等 + rAF 合帧，避免高频 mutation 抖动）
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      if (isSkinOn()) boot();
    });
  }
  if (window.MutationObserver) {
    var mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  document.addEventListener("click", function () {
    setTimeout(syncScreen, 120);
  });
})();
