// netdisk-hub: 网盘授权路由（qa 登录 / OAuth 回调 / 登出）
// 从 server.js 提取，由 server.js require 并调用。
"use strict";

function xunleiLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>迅雷网盘登录</title>
<style>
  body{font-family:-apple-system,"PingFang SC",system-ui,sans-serif;background:#0f1115;color:#cfd3dc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{width:440px;max-width:90vw;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:30px;text-align:center}
  h2{margin:0 0 10px;font-size:18px}
  p{color:#aab0d8;font-size:13px;line-height:1.7;margin:0}
  .st{margin:18px 0;font-size:14px;min-height:20px}
  .btn{border:none;border-radius:12px;padding:12px 22px;font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#7c5cff,#21d4fd);cursor:pointer}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#6b7280;vertical-align:middle}
  .dot.wait{background:#fbbf24} .dot.ok{background:#34d399} .dot.err{background:#f87171}
</style></head>
<body><div class="box">
  <h2>迅雷网盘登录</h2>
  <p>点击下方按钮,会在本机弹出迅雷网盘网页。<br>用手机迅雷 App 扫码或账号登录后,本页会自动检测到连接成功。</p>
  <div class="st" id="st"><span class="dot" id="dot"></span><span id="msg">尚未开始</span></div>
  <button class="btn" id="start">启动浏览器登录</button>
</div>
<script>
  const st=document.getElementById("st"),dot=document.getElementById("dot"),msg=document.getElementById("msg"),btn=document.getElementById("start");
  function set(s,m){dot.className="dot "+s;msg.textContent=m;}
  let timer=null;
  async function start(){
    btn.disabled=true; set("wait","正在启动浏览器…");
    try{
      const r=await fetch("/api/xunlei/login/start",{method:"POST"});
      const j=await r.json();
      if(!j.started){ set("wait", j.message||"已有会话进行中"); }
      poll();
    }catch(e){ set("err","启动失败:"+e.message); btn.disabled=false; }
  }
  function poll(){
    if(timer)clearInterval(timer);
    timer=setInterval(async()=>{
      try{
        const r=await fetch("/api/xunlei/login/status"); const s=await r.json();
        if(s.status==="waiting"){ set("wait", s.message||"等待登录…"); }
        else if(s.status==="done"){
          set("ok","✅ "+s.message); btn.disabled=false;
          try{ if(window.opener){ window.opener.postMessage({provider:"xunlei",authorized:true}, location.origin); } }catch(e){}
          setTimeout(()=>window.close(),1500); clearInterval(timer);
        } else if(s.status==="error"){
          set("err","⚠️ "+s.message); btn.disabled=false; clearInterval(timer);
        }
      }catch(e){}
    },2000);
  }
  btn.onclick=start;
  (async()=>{ try{ const r=await fetch("/api/xunlei/login/status"); const s=await r.json(); if(s.status==="waiting"){ set("wait", s.message||"等待登录…"); poll(); } }catch(e){} })();
</script>
</body></html>`;
}

function baiduLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>百度网盘登录</title>
<style>
  body{font-family:-apple-system,"PingFang SC",system-ui,sans-serif;background:#0f1115;color:#cfd3dc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{width:440px;max-width:90vw;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:30px;text-align:center}
  h2{margin:0 0 10px;font-size:18px}
  p{color:#aab0d8;font-size:13px;line-height:1.7;margin:0}
  .st{margin:18px 0;font-size:14px;min-height:20px}
  .btn{border:none;border-radius:12px;padding:12px 22px;font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#3b82f6,#21d4fd);cursor:pointer}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#6b7280;vertical-align:middle}
  .dot.wait{background:#fbbf24} .dot.ok{background:#34d399} .dot.err{background:#f87171}
</style></head>
<body><div class="box">
  <h2>百度网盘登录</h2>
  <p>点击下方按钮,会在本机弹出百度网盘网页。<br>用手机百度网盘 App 扫码或账号登录后,本页会自动检测到连接成功。</p>
  <div class="st" id="st"><span class="dot" id="dot"></span><span id="msg">尚未开始</span></div>
  <button class="btn" id="start">启动浏览器登录</button>
</div>
<script>
  const st=document.getElementById("st"),dot=document.getElementById("dot"),msg=document.getElementById("msg"),btn=document.getElementById("start");
  function set(s,m){dot.className="dot "+s;msg.textContent=m;}
  let timer=null;
  async function start(){
    btn.disabled=true; set("wait","正在启动浏览器…");
    try{
      const r=await fetch("/api/baidu/login/start",{method:"POST"});
      const j=await r.json();
      if(!j.started){ set("wait", j.message||"已有会话进行中"); }
      poll();
    }catch(e){ set("err","启动失败:"+e.message); btn.disabled=false; }
  }
  function poll(){
    if(timer)clearInterval(timer);
    timer=setInterval(async()=>{
      try{
        const r=await fetch("/api/baidu/login/status"); const s=await r.json();
        if(s.status==="waiting"){ set("wait", s.message||"等待登录…"); }
        else if(s.status==="done"){
          set("ok","✅ "+s.message); btn.disabled=false;
          try{ if(window.opener){ window.opener.postMessage({provider:"baidu",authorized:true}, location.origin); } }catch(e){}
          setTimeout(()=>window.close(),1500); clearInterval(timer);
        } else if(s.status==="error"){
          set("err","⚠️ "+s.message); btn.disabled=false; clearInterval(timer);
        }
      }catch(e){}
    },2000);
  }
  btn.onclick=start;
  (async()=>{ try{ const r=await fetch("/api/baidu/login/status"); const s=await r.json(); if(s.status==="waiting"){ set("wait", s.message||"等待登录…"); poll(); } }catch(e){} })();
</script>
</body></html>`;
}

function quarkLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>夸克网盘登录</title>
<style>
  body{font-family:-apple-system,"PingFang SC",system-ui,sans-serif;background:#0f1115;color:#cfd3dc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{width:440px;max-width:90vw;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:30px;text-align:center}
  h2{margin:0 0 10px;font-size:18px}
  p{color:#aab0d8;font-size:13px;line-height:1.7;margin:0}
  .st{margin:18px 0;font-size:14px;min-height:20px}
  .btn{border:none;border-radius:12px;padding:12px 22px;font-size:14px;font-weight:600;color:#fff;background:linear-gradient(135deg,#7c5cff,#21d4fd);cursor:pointer}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:#6b7280;vertical-align:middle}
  .dot.wait{background:#fbbf24} .dot.ok{background:#34d399} .dot.err{background:#f87171}
</style></head>
<body><div class="box">
  <h2>夸克网盘登录</h2>
  <p>点击下方按钮,会在本机弹出夸克网盘网页。<br>用手机夸克 App 扫码或账号登录后,本页会自动检测到连接成功。</p>
  <div class="st" id="st"><span class="dot" id="dot"></span><span id="msg">尚未开始</span></div>
  <button class="btn" id="start">启动浏览器登录</button>
</div>
<script>
  const st=document.getElementById("st"),dot=document.getElementById("dot"),msg=document.getElementById("msg"),btn=document.getElementById("start");
  function set(s,m){dot.className="dot "+s;msg.textContent=m;}
  let timer=null;
  async function start(){
    btn.disabled=true; set("wait","正在启动浏览器…");
    try{
      const r=await fetch("/api/quark/login/start",{method:"POST"});
      const j=await r.json();
      if(!j.started){ set("wait", j.message||"已有会话进行中"); }
      poll();
    }catch(e){ set("err","启动失败:"+e.message); btn.disabled=false; }
  }
  function poll(){
    if(timer)clearInterval(timer);
    timer=setInterval(async()=>{
      try{
        const r=await fetch("/api/quark/login/status"); const s=await r.json();
        if(s.status==="waiting"){ set("wait", s.message||"等待登录…"); }
        else if(s.status==="done"){
          set("ok","✅ "+s.message); btn.disabled=false;
          try{ if(window.opener){ window.opener.postMessage({provider:"quark",authorized:true}, location.origin); } }catch(e){}
          setTimeout(()=>window.close(),1500); clearInterval(timer);
        } else if(s.status==="error"){
          set("err","⚠️ "+s.message); btn.disabled=false; clearInterval(timer);
        }
      }catch(e){}
    },2000);
  }
  btn.onclick=start;
  (async()=>{ try{ const r=await fetch("/api/quark/login/status"); const s=await r.json(); if(s.status==="waiting"){ set("wait", s.message||"等待登录…"); poll(); } }catch(e){} })();
</script>
</body></html>`;
}

// 注册所有授权路由到 app
// deps: { store, logger, baidu, baiduAuth, quark, quarkAuth, xunlei, xunleiAuth }
module.exports = function registerAuthRoutes(app, deps) {
  const { store, logger, baidu, baiduAuth, quark, quarkAuth, xunlei, xunleiAuth } = deps;

  // 百度 OAuth 授权入口
  app.get("/auth/baidu", (req, res) => {
    const acc = store.getAccount("baidu");
    if (acc && acc.cookie) {
      return res.redirect("/?authorized=baidu");
    }
    const cfg = baidu.getConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      return res.redirect("/?error=no_config");
    }
    res.redirect(baidu.authorizeUrl());
  });

  // 百度 OAuth 回调
  app.get("/auth/baidu/callback", async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) return res.send("授权失败:未收到 code");
      const data = await baidu.exchangeCode(code);
      store.saveAccount("baidu", {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in || 2592000) * 1000,
        scope: data.scope,
      });
      res.type("html").send("<!doctype html><html><head><meta charset=utf-8><title>授权完成</title></head><body style=\"font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1115;color:#cfd3dc\"><p>百度授权成功,正在返回…</p><script>try { if (window.opener) { window.opener.postMessage({ provider: \"baidu\", authorized: true }, location.origin); setTimeout(function(){ window.close(); }, 300); } else { location.href = \"/?authorized=baidu\"; } } catch (e) { location.href = \"/?authorized=baidu\"; }</script></body></html>");
    } catch (e) {
      res.redirect("/?error=auth_failed&msg=" + encodeURIComponent(e.message));
    }
  });

  // 夸克登录
  app.get("/auth/quark", (req, res) => { res.type("html").send(quarkLoginPage()); });
  app.post("/api/quark/login/start", (req, res) => {
    const s = quarkAuth.getState();
    if (s.status === "waiting") return res.json({ started: false, message: "已有登录会话进行中" });
    quarkAuth.startLogin();
    res.json({ started: true });
  });
  app.get("/api/quark/login/status", (req, res) => { res.json(quarkAuth.getState()); });
  app.post("/api/quark/logout", (req, res) => {
    const acc = store.getAccount("quark") || {};
    store.saveAccount("quark", { ...acc, cookie: "", connected: false });
    res.json({ ok: true });
  });

  // 迅雷登录
  app.get("/auth/xunlei", (req, res) => { res.type("html").send(xunleiLoginPage()); });
  app.post("/api/xunlei/login/start", (req, res) => {
    const s = xunleiAuth.getState();
    if (s.status === "waiting") return res.json({ started: false, message: "已有登录会话进行中" });
    xunleiAuth.startLogin();
    res.json({ started: true });
  });
  app.get("/api/xunlei/login/status", (req, res) => { res.json(xunleiAuth.getState()); });
  app.post("/api/xunlei/logout", (req, res) => {
    const acc = store.getAccount("xunlei") || {};
    store.saveAccount("xunlei", { ...acc, connected: false, loginAt: null });
    res.json({ ok: true });
  });

  // 百度 Cookie 登录（Playwright）
  app.get("/auth/baidu/cookie", (req, res) => { res.type("html").send(baiduLoginPage()); });
  app.post("/api/baidu/login/start", (req, res) => {
    const s = baiduAuth.getState();
    if (s.status === "waiting") return res.json({ started: false, message: "已有登录会话进行中" });
    baiduAuth.startLogin();
    res.json({ started: true });
  });
  app.get("/api/baidu/login/status", (req, res) => { res.json(baiduAuth.getState()); });
  app.post("/api/baidu/logout", (req, res) => {
    const acc = store.getAccount("baidu") || {};
    store.saveAccount("baidu", { ...acc, cookie: "", connected: false });
    res.json({ ok: true });
  });
};
