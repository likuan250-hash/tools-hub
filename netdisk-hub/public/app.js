// 主题由工具箱统一控制（webview-preload 注入 data-theme 并隐藏主题按钮），子页面不再自行管理。

// Banner(授权回调提示)
const params = new URLSearchParams(location.search);
const banner = document.getElementById('banner');
// 状态横幅：渲染为玻璃胶囊（成功绿 / 失败红 / 无配置灰）
function setBanner(level, msg) {
  banner.className = 'banner show';
  banner.innerHTML = statusHTML(level, msg);
}
if (params.get('authorized') === 'baidu') {
  setBanner('ok', '百度网盘授权成功,可以开始转存了');
  history.replaceState({}, '', '/');
} else if (params.get('authorized') === 'quark') {
  setBanner('ok', '夸克网盘授权成功,可以开始转存了');
  history.replaceState({}, '', '/');
} else if (params.get('authorized') === 'xunlei') {
  setBanner('ok', '迅雷网盘授权成功,可以开始转存了');
  history.replaceState({}, '', '/');
} else if (params.get('error') === 'no_config') {
  setBanner('off', '尚未配置百度应用凭证,请在 .env 填写 BAIDU_CLIENT_ID / BAIDU_CLIENT_SECRET 后重启');
} else if (params.get('error') === 'auth_failed') {
  setBanner('err', '百度授权失败:' + (params.get('msg') || '未知错误'));
}

// ── 统一执行按钮 loading 切换（macOS 线性图标风格：执行中显示 spinner + 执行中…）──
function setExec(btn, on) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.label === undefined) {
      var l = btn.querySelector('.bx-label');
      btn.dataset.label = l ? l.textContent : btn.textContent;
    }
    btn.classList.add('is-loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    var lbl = btn.querySelector('.bx-label');
    if (lbl) lbl.textContent = '执行中…';
  } else {
    btn.classList.remove('is-loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    var lbl2 = btn.querySelector('.bx-label');
    if (lbl2 && btn.dataset.label !== undefined) lbl2.textContent = btn.dataset.label;
  }
}

// ── 轻量 Toast（T05：与 biliup/kdocs 统一，玻璃 .toast-host + 子节点，3s 自动消失，复用 pop-in 入场）──
function toast(msg, type) {
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const isErr = type === 'err';
  // 消息内已内联 ico() SVG（如错误态显式带 cross）时不再叠加 .toast-ico，避免双图标
  const hasInlineIcon = typeof msg === 'string' && msg.indexOf('ico(') !== -1;
  const el = document.createElement('div');
  el.className = 'toast pop-in';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span class="toast-ico"></span><span class="toast-msg"></span>';
  el.querySelector('.toast-ico').innerHTML = hasInlineIcon ? '' : (isErr ? ico('cross') : ico('check'));
  const msgEl = el.querySelector('.toast-msg');
  if (hasInlineIcon) msgEl.innerHTML = msg; else msgEl.textContent = msg;
  host.appendChild(el);
  // 3s 后淡出移除；reduced-motion 下过渡被全局降级为瞬隐，不影响功能
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }, 3000);
}

// 授权:弹窗打开对应网盘的授权/登录页
function openAuth(provider) {
  const path = provider === 'baidu' ? '/auth/baidu/cookie' : '/auth/' + provider;
  const w = window.open(path, provider + 'Auth', 'width=520,height=720');
  if (!w) toast('浏览器拦截了弹窗,请允许本站弹窗后重试', 'err');
}
// 监听弹窗回传:授权成功后自动刷新账号状态并显示成功提示
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data && e.data.provider === 'baidu' && e.data.authorized) {
    loadAccounts();
    setBanner('ok', '百度网盘授权成功,可以开始转存了');
  }
  if (e.data && e.data.provider === 'quark' && e.data.authorized) {
    loadAccounts();
    setBanner('ok', '夸克网盘授权成功,可以开始转存了');
  }
  if (e.data && e.data.provider === 'xunlei' && e.data.authorized) {
    loadAccounts();
    setBanner('ok', '迅雷网盘授权成功,可以开始转存了');
  }
});

// 账号卡片
async function loadAccounts() {
  const cards = document.getElementById('cards');
  // 先渲染「检查中」占位(避免校验网络耗时期间空白)
  const names = ['百度网盘', '夸克网盘', '迅雷网盘'];
  cards.innerHTML = names.map((n) => `<div class="card"><div class="name">${n}</div><div class="status">${statusHTML('off', '检测中…')}</div></div>`).join('');
  try {
    const r = await fetch('/api/accounts');
    const d = await r.json();
    const defs = [
      { key: 'baidu', name: '百度网盘', a: d.baidu },
      { key: 'quark', name: '夸克网盘', a: d.quark },
      { key: 'xunlei', name: '迅雷网盘', a: d.xunlei },
    ];
    cards.innerHTML = defs.map(({ key, name, a }) => {
      const connected = !!(a && a.connected);
      // 已登录但实时联网探测未通过: 区分「登录态真失效」与「仅网络探测不通」
      let warn = '';
      if (connected && a.pingOK === false && a.detail) {
        const d = a.detail;
        if (d.startsWith('baidu_errno')) {
          // 真·登录态失效(接口返回错误): 橙色提醒 + 下方仍提供「重新授权」按钮
          warn = `<div class="meta" style="margin-top:6px;font-size:12px;opacity:.85;color:var(--warn,#e0a030)">百度返回错误 ${d.slice(12)}(登录态可能失效,可重新授权)</div>`;
        } else {
          // 网络/代理探测不通: 仅为参考,不影响实际转存,降级为灰色中性备注
          const reason = d.startsWith('net_error') ? ('网络/代理探测不通: ' + d.slice(10)) : ('联网校验未通过: ' + d);
          warn = `<div class="meta" style="margin-top:6px;font-size:12px;opacity:.6;color:var(--txt,#888)">· ${reason}(不影响转存,实际失败再处理)</div>`;
        }
      }
      // 未连接时展示诊断原因, 便于定位(网络/百度返回错误/cookie 缺失)
      let diag = '';
      if (!connected && a && a.detail) {
        const d = a.detail;
        let msg;
        if (d === 'no_cookie_saved' || d === 'no_session_cookie') msg = '百度登录态未保存(请重新点授权并完成扫码)';
        else if (d.startsWith('net_error')) msg = '服务器无法连接百度(网络/代理问题: ' + d.slice(10) + ')';
        else if (d.startsWith('baidu_errno')) msg = '百度返回错误 ' + d.slice(12) + '(登录态可能被作废,请重新授权)';
        else msg = d;
        diag = `<div class="meta" style="margin-top:6px;font-size:12px;opacity:.75;color:var(--err)">诊断: ${msg}</div>`;
      }
      // 登录态剩余天数（授权时抓取的 cookie 真实过期时间；无则显示有效期未知，不误报）
      let ttlHTML = '';
      if (connected && a.expiresAt) {
        const days = Math.ceil((a.expiresAt - Date.now()) / 86400000);
        const prefix = a.expiresAtEstimated ? "约 " : "";
        if (days <= 0) {
          ttlHTML = '<div><span class="ttl ttl-dead"><span class="p"></span>登录态已过期，请重新授权</span></div>';
        } else if (days <= 7) {
          ttlHTML = `<div><span class="ttl ttl-warn"><span class="p"></span>登录态剩余 ${prefix}${days} 天，请提前重新授权</span></div>`;
        } else {
          ttlHTML = `<div><span class="ttl ttl-ok"><span class="p"></span>登录态剩余 ${prefix}${days} 天</span></div>`;
        }
      } else if (connected) {
        ttlHTML = '<div><span class="ttl ttl-none"><span class="p"></span>登录态有效期未知</span></div>';
      }
      // 未连接必须授权; 已连接但「登录态真失效(baidu_errno)」才提示重新授权。
      // 仅网络探测不通(net_error)不算故障,不弹重授权(重授权救不了网络,反而误导)。
      const reallyBad = connected && a.pingOK === false && a.detail && a.detail.startsWith('baidu_errno');
      const showAuth = !connected || reallyBad;
      const authBtnText = connected ? (ico('refresh') + ' 重新授权' + name) : (ico('link') + ' 授权' + name);
      const authLink = showAuth
        ? `<div style="margin-top:10px"><button class="auth-btn" onclick="openAuth('${key}')">${authBtnText}</button></div>` : '';
      // 转存目录行:显示当前目录(已选/默认),已连接时提供「选择目录」按钮
      const dir = a && a.dir;
      let dirRow = '';
      if (dir && dir.effective) {
        const tag = dir.userSet ? (ico('folder') + ' 转存到(已选)') : (ico('folder') + ' 转存到(默认)');
        const dirBtn = connected
          ? `<button class="dir-btn" onclick="openDirPicker('${key}')">选择目录</button>`
          : '';
        dirRow = `<div class="dir-row"><span class="dir-label">${tag}: <b>${escapeHtml(dir.effective)}</b></span>${dirBtn}</div>`;
      }
      return `<div class="card">
        <div class="name">${name}</div>
        <div class="status">${statusHTML(reallyBad ? 'err' : (connected ? 'ok' : 'off'), reallyBad ? '登录态失效' : (connected ? '已连接' : '未连接'))}</div>
        ${ttlHTML}
        ${warn}${diag}
        ${dirRow}
        ${authLink}
      </div>`;
    }).join('');
  } catch (e) { /* 网络失败则保留检查中占位 */ }
}

// 任务历史(可折叠 + Tab 过滤 + 复制/重试/清空)
let allTasks = [];
let historyFilter = 'success';
let groupMap = {}; // 分组索引 → {title, list}，供「复制本组」弹窗取数据

function updateCounts() {
  const s = allTasks.filter((t) => t.status === 'success').length;
  const f = allTasks.filter((t) => t.status === 'failed').length;
  document.getElementById('cntAll').textContent = allTasks.length;
  document.getElementById('cntSuccess').textContent = s;
  document.getElementById('cntFailed').textContent = f;
}

function renderTasks() {
  const box = document.getElementById('tasks');
  // 同步 Tab 高亮状态,防止视觉与当前 filter 不一致
  document.querySelectorAll('#historyTabs .tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-filter') === historyFilter));
  // 「清空异常」仅在选择「异常」Tab 时显示
  document.getElementById('clearFailed').style.display = historyFilter === 'failed' ? '' : 'none';

  // 过滤(条目级): Tab 选「成功/失败」时只保留对应条目,空组随后不显示
  let items = allTasks;
  if (historyFilter !== 'all') items = items.filter((t) => t.status === historyFilter);
  if (!items.length) {
    const msg = historyFilter === 'failed' ? '暂无异常的转存' : historyFilter === 'success' ? '暂无成功的转存' : '还没有转存记录';
    box.innerHTML = `<div class="empty-state"><span class="es-ico">${ico('inbox')}</span>${msg}</div>`;
    return;
  }

  // 按标题分组(无标题→「（未命名）」);组内按 provider 固定顺序,组间按组内最新时间倒序
  const PROVIDER_ORDER = { baidu: 0, quark: 1, xunlei: 2 };
  const groups = new Map();
  for (const t of items) {
    const key = (t.title && t.title.trim()) || '（未命名）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const groupArr = Array.from(groups.entries()).map(([title, list]) => {
    const latest = list.reduce((mx, t) => Math.max(mx, new Date(t.createdAt).getTime()), 0);
    return { title, list, latest };
  }).sort((a, b) => b.latest - a.latest);

  groupMap = {};
  box.innerHTML = groupArr.map(({ title, list }, gi) => {
    groupMap[gi] = { title, list };
    const hasOk = list.some((t) => t.status === 'success' && t.shareLink);
    const okCount = list.filter((t) => t.status === 'success').length;
    const failCount = list.filter((t) => t.status === 'failed').length;
    const summary = failCount ? `${okCount} 成功 / ${failCount} 失败` : `${okCount} 成功`;
    const summaryPill = failCount ? statusHTML('err', summary) : statusHTML('ok', summary);
    const sorted = [...list].sort((a, b) => (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9));
    const rows = sorted.map((t) => {
      const name = t.provider === 'baidu' ? '百度' : t.provider === 'quark' ? '夸克' : t.provider === 'xunlei' ? '迅雷' : t.provider;
      const badge = t.status === 'success' ? statusHTML('ok', '成功', { size: 'sm' }) : statusHTML('err', '失败', { size: 'sm' });
      const time = new Date(t.createdAt).toLocaleString('zh-CN');
      let actions = '';
      if (t.status === 'success' && t.shareLink) {
        actions = `<div class="row-actions"><button class="copy" data-copy-text="${escapeHtml(t.shareLink)}">复制分享</button></div>`;
      } else if (t.status === 'failed') {
        actions = `<div class="row-actions"><button class="retry" data-retry="${t.provider}" data-link="${escapeHtml(t.sourceLink || '')}" data-pwd="${escapeHtml(t.sourcePwd || '')}">重试</button></div>`;
      }
      const share = t.shareLink
        ? `<div class="meta">我的分享: <a href="${escapeHtml(t.shareLink)}" target="_blank" style="color:var(--accent-2)">${escapeHtml(t.shareLink)}</a>${t.sharePwd ? ' / 提取码:' + escapeHtml(t.sharePwd) : ''}</div>`
        : (t.status === 'success' ? '<div class="meta">未生成分享</div>' : `<div class="meta" style="color:var(--err)">${escapeHtml(t.error || '')}</div>`);
      return `<div class="task">
        <div class="top"><b>${name}</b>${badge}</div>
        <div class="meta">源: ${escapeHtml(t.sourceLink || '-')}${t.sourcePwd ? ' / 码:' + escapeHtml(t.sourcePwd) : ''}</div>
        ${share}
        <div class="meta">${time}${t.fileCount ? ' · ' + t.fileCount + ' 个文件' : ''}</div>
        ${actions}
      </div>`;
    }).join('');
    return `<div class="task-group">
      <div class="group-head">
        <span class="group-title">${escapeHtml(title)}</span>
        <span class="group-actions">
          <span class="group-summary">${summaryPill}</span>
          ${hasOk ? `<button class="group-copy" data-copy-group="${gi}">${ico('clipboard')} 复制本组</button>` : ''}
        </span>
      </div>
      ${rows}
    </div>`;
  }).join('');
}

async function loadTasks() {
  try {
    const r = await fetch('/api/tasks');
    allTasks = await r.json();
    updateCounts();
    renderTasks();
  } catch (e) { /* ignore */ }
}

// ── 转存中心:单条/三段式合并,勾选网盘,一键复制三段式结果 ──
const batchBtn = document.getElementById('batchBtn');
const batchText = document.getElementById('batchText');
const batchErr = document.getElementById('batchErr');
const batchPreview = document.getElementById('batchPreview');
const batchResult = document.getElementById('batchResult');
const providerChecks = document.getElementById('providerChecks');
const batchMakeShare = document.getElementById('batchMakeShare');
const forceRe = document.getElementById('forceRe');
const PROVIDER_NAME = { baidu: '百度', quark: '夸克', xunlei: '迅雷' };
const PROVIDER_LABEL = { baidu: '链接: ', quark: '链接：', xunlei: '链接：' };

let parsedState = { title: '', jobs: {}, order: [] };
let lastResults = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 解析标题 + 三个网盘链接 + 提取码
// 支持单行/多行;链接在遇到 链接/空白/# 时截断,避免串行
// 新增:识别「提取码: xxx」单独成行(百度/夸克分享最常见形态),按最近原则归位到对应网盘
function parseBatch(text) {
  const raw = text || '';
  const trimmed = raw.trim();
  if (!trimmed) return { title: '', jobs: {}, order: [] };

  const lines = trimmed.split(/\r?\n/);
  const linkRe = /(pan\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s#]*)?)|(pan\.xunlei\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s#]*)?)|(pan\.quark\.cn\/s\/[A-Za-z0-9_-]+(?:\?[^\s#]*)?)/;
  // 显式「提取码/密码/口令: 1234」形态
  const pwdRe = /(?:提取码|密码|提取口令|访问码|口令|pwd)\s*[:：]?\s*([A-Za-z0-9]{4,12})/i;
  // 纯提取码行(整行仅 4-12 位字母数字,无空格/标点),作为兜底
  const bareCodeRe = /^[A-Za-z0-9]{4,12}$/;

  const jobs = {};
  const order = [];
  const linkLines = [];      // { provider, lineNo }
  const pwdCandidates = [];  // { lineNo, pwd, keyword } —— keyword=true 来自显式「提取码:」

  lines.forEach((line, i) => {
    const lm = line.match(linkRe);
    if (lm) {
      const provider = lm[1] ? 'baidu' : lm[2] ? 'xunlei' : 'quark';
      if (jobs[provider]) return; // 同网盘只取第一个
      const link = 'https://' + lm[0];
      const pm = link.match(/[?&]pwd=([A-Za-z0-9]+)/);
      jobs[provider] = { provider, link, pwd: pm ? pm[1] : '' };
      order.push(provider);
      linkLines.push({ provider, lineNo: i });
    } else {
      const pm = line.match(pwdRe);
      if (pm) {
        pwdCandidates.push({ lineNo: i, pwd: pm[1], keyword: true });
      } else if (bareCodeRe.test(line.trim()) && linkLines.length) {
        // 纯代码行 + 已出现链接,记为兜底候选(同网盘不会重复添加)
        pwdCandidates.push({ lineNo: i, pwd: line.trim(), keyword: false });
      }
    }
  });

  // 分配提取码:先处理显式「提取码:」行,再处理纯代码兜底行;均按「最近链接」归位
  const assignQueue = pwdCandidates
    .sort((a, b) => (b.keyword - a.keyword)) // 显式优先
    .map((c) => c);
  for (const cand of assignQueue) {
    if (!linkLines.length) break;
    let best = null, bestDist = Infinity;
    for (const item of linkLines) {
      const d = Math.abs(item.lineNo - cand.lineNo);
      if (d < bestDist) { bestDist = d; best = item; }
    }
    if (best && !jobs[best.provider].pwd) {
      jobs[best.provider].pwd = cand.pwd;
    }
  }

  // 标题 = 第一个有效网盘链接之前的文本;逐行剔除「链接: xxx」「http(s)://...」等占位/残缺行,避免空链接混入标题
  const firstLinkIdx = trimmed.search(linkRe);
  let title = '';
  if (firstLinkIdx > 0) {
    title = trimmed.slice(0, firstLinkIdx)
      .split(/\r?\n/)
      .filter((line) => !/^\s*链接\s*[:：]?/.test(line) && !/^\s*https?:\/\//i.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^https?:\/\//i.test(title)) title = '';
  }

  return { title, jobs, order };
}

function renderChecksHTML() {
  if (!parsedState.order.length) {
    return '<div class="hint">粘贴分享文本后将自动识别可用网盘</div>';
  }
  const titleHtml = parsedState.title
    ? `<div class="hint" style="margin-bottom:8px">已识别标题: <b>${escapeHtml(parsedState.title)}</b></div>`
    : '';
  const rows = parsedState.order.map((p) => {
    const j = parsedState.jobs[p];
    return `<label class="provider-check">
      <input type="checkbox" value="${p}" checked>
      <span class="check-name">${PROVIDER_NAME[p]}</span>
      <span class="check-meta">${escapeHtml(j.link)}${j.pwd ? ' / 码: ' + escapeHtml(j.pwd) : ''}</span>
    </label>`;
  }).join('');
  return titleHtml + rows;
}

function refreshUI() {
  parsedState = parseBatch(batchText.value);
  providerChecks.innerHTML = renderChecksHTML();
  batchResult.className = 'batch-result';
  batchResult.innerHTML = '';
  batchErr.className = 'err';
  batchErr.textContent = '';
}

function getSelectedJobs() {
  const checked = Array.from(providerChecks.querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.value);
  return checked.map((p) => parsedState.jobs[p]).filter(Boolean);
}

function isValidShareLink(link, provider) {
  if (typeof link !== 'string' || !link) return false;
  const bare = link.split('?')[0].split('#')[0];
  const patterns = {
    baidu: /^(https?:\/\/)?pan\.baidu\.com\/s\/[A-Za-z0-9_-]{5,}$/,
    quark: /^(https?:\/\/)?pan\.quark\.cn\/s\/[A-Za-z0-9_-]{5,}$/,
    xunlei: /^(https?:\/\/)?pan\.xunlei\.com\/s\/[A-Za-z0-9_-]{5,}$/,
  };
  if (provider && patterns[provider]) return patterns[provider].test(bare);
  return Object.values(patterns).some((re) => re.test(bare));
}

function buildCopyAllText(results) {
  const ok = (results || []).filter((r) => r.ok && r.share && isValidShareLink(r.share.link, r.provider));
  if (!ok.length) return '';
  const lines = ok.map((r) => PROVIDER_LABEL[r.provider] + r.share.link);
  // 标题独占一行,每个网盘链接各起一行(用户要求回车分隔,便于直接粘贴)
  const out = [];
  if (parsedState.title) out.push(parsedState.title);
  out.push(...lines);
  return out.join('\n');
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => btn.textContent = old, 1200);
  });
}

function renderResults(results) {
  lastResults = results || [];
  const ok = lastResults.filter((r) => r.ok && r.share && isValidShareLink(r.share.link, r.provider));
  const html = lastResults.map((res) => {
    const name = PROVIDER_NAME[res.provider] || res.provider;
    if (!res.ok) {
      return `<div class="br-card fail">${statusHTML('err', '失败', { size: 'sm' })}<div class="br-name">${name}</div><div class="br-meta">${escapeHtml(res.error)}</div></div>`;
    }
    const link = res.share && res.share.link ? res.share.link : '';
    const count = res.files ? res.files.length : 0;
    let metaLine, linkArea;
    if (res.needShare) {
      metaLine = '↩ 来自历史,需补生成分享';
      linkArea = `<div class="br-meta" style="color:#e0941a">${escapeHtml(res.message || '请勾选「强制重转」补生成分享')}</div>`;
    } else {
      metaLine = res.fromCache ? '↩ 来自历史,跳过转存' : `转存 ${count} 个文件`;
      linkArea = `<div class="br-meta" style="display:flex;align-items:flex-start;gap:8px">
        <a href="${escapeHtml(link)}" target="_blank" style="flex:1;word-break:break-all">${escapeHtml(link)}</a>
        <button class="copy" data-copy-text="${escapeHtml(PROVIDER_LABEL[res.provider] + link)}">复制</button>
      </div>`;
    }
    return `<div class="br-card">
      ${statusHTML('ok', '成功', { size: 'sm' })}
      <div class="br-name">${name}</div>
      <div class="br-meta">${metaLine}</div>
      ${linkArea}
    </div>`;
  }).join('');

  const copyAll = ok.length
    ? `<button class="btn ghost copy-all" data-copy-all style="margin-top:14px">${ico('clipboard')} 一键复制全部</button>`
    : '';
  const preview = parsedState.title && ok.length
    ? `<div class="hint" style="margin-top:12px">复制内容预览:</div><div class="copy-preview">${escapeHtml(buildCopyAllText(lastResults))}</div>`
    : '';

  batchResult.innerHTML = html + copyAll + preview;
  batchResult.className = 'batch-result show';
}

batchText.oninput = refreshUI;
batchText.onpaste = () => setTimeout(refreshUI, 0);

// ── 转存执行进度（SSE 实时，kdocs 一键执行同款语言）──
const transferProgress = document.getElementById('transferProgress');
const transferStepsEl = document.getElementById('transferSteps');
const transferLogEl = document.getElementById('transferLog');
let transferStepEls = [];
let transferES = null;

function transferAddLog(level, msg) {
  if (!transferLogEl) return;
  const line = document.createElement('div');
  line.className = 'line lvl-' + (level || 'info');
  line.textContent = msg || '';
  transferLogEl.appendChild(line);
  transferLogEl.scrollTop = transferLogEl.scrollHeight;
}

function renderTransferStep(s) {
  if (!s || s.index == null) return;
  const icon = s.status === '成功' ? ico('check') : s.status === '跳过' ? ico('skip') : s.status === '失败' ? ico('cross') : s.status === '警告' ? ico('warning') : ico('refresh');
  const detailParts = [];
  if (s.files != null) detailParts.push('文件数: ' + s.files);
  if (s.fromCache) detailParts.push('来自历史缓存');
  if (s.link) detailParts.push('<span class="link">' + escapeHtml(s.link) + '</span>' + (s.pwd ? '（' + escapeHtml(s.pwd) + '）' : ''));
  if (s.reason) detailParts.push('<span class="err">' + escapeHtml(s.reason) + '</span>');
  const detail = detailParts.join(' · ');
  const lvl = { '进行中': 'info', '成功': 'ok', '失败': 'err', '跳过': 'off', '警告': 'warn' }[s.status] || 'info';
  let item = transferStepEls[s.index];
  if (!item) {
    item = document.createElement('div');
    item.className = 'step-item';
    transferStepsEl.appendChild(item);
    transferStepEls[s.index] = item;
  }
  item.innerHTML = '<span class="step-icon">' + icon + '</span><div class="step-body"><div class="step-name">' + statusHTML(lvl, escapeHtml(s.name + ' — ' + s.status)) + '</div>' + (detail ? '<div class="step-detail">' + detail + '</div>' : '') + '</div>';
}

function resetTransferProgress() {
  if (!transferProgress) return;
  transferStepsEl.innerHTML = '';
  transferLogEl.innerHTML = '';
  transferStepEls = [];
  transferProgress.style.display = 'block';
}

function openTransferSSE(clientId) {
  const es = new EventSource('/api/transfer/events?client=' + clientId);
  transferES = es;
  es.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
    if (d.type === 'step' && d.step) renderTransferStep(d.step);
    else if (d.type === 'log') transferAddLog(d.level, d.message);
    else if (d.type === 'done') { transferAddLog('ok', '转存完成：成功 ' + d.okCount + '/' + d.total); es.close(); transferES = null; }
  };
  es.onerror = () => { es.close(); transferES = null; };
  return es;
}

// 清空输入:一键清空分享文本框,并同步重置网盘勾选区与结果区
const clearText = document.getElementById('clearText');
clearText.onclick = () => {
  batchText.value = '';
  refreshUI();
  batchText.focus();
};

batchBtn.onclick = async () => {
  batchErr.className = 'err'; batchErr.textContent = '';
  batchResult.className = 'batch-result'; batchResult.innerHTML = '';
  refreshUI();
  const jobs = getSelectedJobs();
  if (!jobs.length) {
    // 空点校验：仅保留轻量 toast 反馈，去掉红色边框横幅（v2.1.8：用户反馈此处不需要红色提示）
    const msg = parsedState.order.length ? '请先勾选要转存的网盘' : '请先粘贴网盘分享链接';
    toast(msg, 'err');
    return;
  }
  setExec(batchBtn, true);
  const clientId = 't' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  resetTransferProgress();
  const es = openTransferSSE(clientId);
  try {
    const r = await fetch('/api/transfer/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobs,
        makeShare: batchMakeShare.checked,
        force: forceRe.checked,
        title: parsedState.title || '',
        client: clientId,
      }),
    });
    const d = await r.json();
    if (!d.ok) { batchErr.className = 'err show'; batchErr.innerHTML = ico('cross') + ' ' + escapeHtml(d.error); return; }
    renderResults(d.results);
    loadTasks();
  } catch (e) {
    batchErr.className = 'err show'; batchErr.innerHTML = statusHTML('err', ico('cross') + ' ' + e.message);
  } finally {
    setExec(batchBtn, false);
    if (transferES) { transferES.close(); transferES = null; }
  }
};

// 复制按钮:支持 data-copy-text 与 data-copy-all
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-copy-text], [data-copy-all]');
  if (!t) return;
  if (t.hasAttribute('data-copy-all')) {
    copyText(buildCopyAllText(lastResults), t);
  } else {
    copyText(t.getAttribute('data-copy-text'), t);
  }
});

// 历史分组「复制本组」:弹出预览窗,确认后复制(只含成功链接,失败自动跳过)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-group]');
  if (!btn) return;
  const g = groupMap[btn.getAttribute('data-copy-group')];
  if (g) openCopyGroupModal(g);
});

// 取分组内成功的分享,按 百度→迅雷→夸克 固定顺序拼成与全局一致的格式
function buildCopyGroupText(group) {
  const PROVIDER_ORDER = { baidu: 0, quark: 1, xunlei: 2 };
  const ok = (group.list || []).filter((t) => t.status === 'success' && t.shareLink && isValidShareLink(t.shareLink, t.provider));
  if (!ok.length) return '';
  const sorted = [...ok].sort((a, b) => (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9));
  const lines = sorted.map((t) => PROVIDER_LABEL[t.provider] + t.shareLink);
  const out = [];
  const title = (group.title || '').trim();
  if (title && title !== '（未命名）') out.push(title);
  out.push(...lines);
  return out.join('\n');
}

function openCopyGroupModal(group) {
  const text = buildCopyGroupText(group);
  if (!text) return;
  document.getElementById('copyGroupText').value = text;
  document.getElementById('copyGroupModal').classList.add('show');
}

function closeCopyGroupModal() {
  document.getElementById('copyGroupModal').classList.remove('show');
}

document.getElementById('copyGroupConfirm').addEventListener('click', () => {
  const ta = document.getElementById('copyGroupText');
  copyText(ta.value, document.getElementById('copyGroupConfirm'));
  setTimeout(closeCopyGroupModal, 900);
});

document.getElementById('copyGroupModal').addEventListener('click', (e) => {
  if (e.target.id === 'copyGroupModal') closeCopyGroupModal();
});

// 失败记录「重试」:强制重转该网盘并生成新分享
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-retry]');
  if (!btn) return;
  const provider = btn.getAttribute('data-retry');
  const link = btn.getAttribute('data-link');
  const pwd = btn.getAttribute('data-pwd') || '';
  if (!link) return;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '重试中…';
  const clientId = 't' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  resetTransferProgress();
  const es = openTransferSSE(clientId);
  try {
    const r = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, link, pwd, makeShare: true, force: true, title: parsedState.title || '', client: clientId }),
    });
    const d = await r.json();
    if (d.ok) { loadTasks(); }
    else { toast('重试失败: ' + (d.error || ''), 'err'); btn.disabled = false; btn.textContent = old; }
  } catch (err) { btn.disabled = false; btn.textContent = old; }
  finally { if (transferES) { transferES.close(); transferES = null; } }
});

// ── 统一弹窗机制（openModal/closeModal，对齐 biliup/kdocs，来去一致、回到原页、不丢上下文）──
let activeModal = null;
function openModal(modalEl) {
  if (!modalEl) return;
  activeModal = modalEl; // 记录当前浮层，关闭即回到下层原页（不切路由、不重置表单）
  const panel = modalEl.querySelector('.modal');
  if (panel) {
    panel.classList.remove('pop-in');
    void panel.offsetWidth; // 强制 reflow 以重放入场动画
    panel.classList.add('pop-in'); // 复用 macos-motion 的 popIn（reduced-motion 下自动降级）
  }
  modalEl.classList.add('show');
}
function closeModal() {
  if (!activeModal) return;
  activeModal.classList.remove('show');
  const panel = activeModal.querySelector('.modal');
  if (panel) panel.classList.remove('pop-in');
  activeModal = null;
}

// 历史 / 格式化：由卡片 header 右上角图标按钮触发厚玻璃弹窗（渲染逻辑不变，仅触发方式改）
const historyMaskEl = document.getElementById('historyMask');
const fmtMaskEl = document.getElementById('fmtMask');
document.getElementById('historyIconBtn').addEventListener('click', () => { openModal(historyMaskEl); });
document.getElementById('fmtIconBtn').addEventListener('click', () => { openModal(fmtMaskEl); });
document.getElementById('historyClose').addEventListener('click', closeModal);
document.getElementById('fmtClose').addEventListener('click', closeModal);
if (historyMaskEl) historyMaskEl.addEventListener('click', (e) => { if (e.target === historyMaskEl) closeModal(); });
if (fmtMaskEl) fmtMaskEl.addEventListener('click', (e) => { if (e.target === fmtMaskEl) closeModal(); });

document.getElementById('historyTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  historyFilter = tab.getAttribute('data-filter');
  document.querySelectorAll('#historyTabs .tab').forEach((b) => b.classList.toggle('active', b === tab));
  renderTasks();
});

document.getElementById('clearFailed').addEventListener('click', async () => {
  if (!confirm('确定清空所有异常(失败)记录?')) return;
  try {
    const r = await fetch('/api/tasks/failed', { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) loadTasks();
  } catch (e) { /* ignore */ }
});

// ── 转存目录选择(网页选目录,选完持久化,下次不再选) ──
let dirCtx = { provider: '', stack: [], folders: [], loading: false };
const ROOT_ID = { baidu: '/', quark: '0', xunlei: '' };

async function openDirPicker(provider) {
  dirCtx = { provider, stack: [{ id: ROOT_ID[provider], name: '根目录' }], folders: [], loading: false };
  const modal = document.getElementById('dirModal');
  modal.classList.add('show');
  document.getElementById('dirModalTitle').textContent = '选择「' + (PROVIDER_NAME[provider] || provider) + '」转存目录';
  renderBreadcrumb();
  await browseDir(ROOT_ID[provider]);
}

async function browseDir(parentId) {
  const listEl = document.getElementById('dirList');
  listEl.innerHTML = '<div class="empty-state"><span class="es-ico">' + ico('hourglass') + '</span>加载中…</div>';
  document.getElementById('dirHint').textContent = '';
  try {
    const r = await fetch('/api/dirs/' + dirCtx.provider + '/browse?parent=' + encodeURIComponent(parentId));
    const d = await r.json();
    if (!r.ok) {
      listEl.innerHTML = '<div class="empty-state" style="color:var(--err)"><span class="es-ico">' + ico('warning') + '</span>' + escapeHtml(d.error || '加载失败') + '</div>';
      return;
    }
    dirCtx.folders = d.folders || [];
    renderDirList();
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state" style="color:var(--err)"><span class="es-ico">' + ico('warning') + '</span>' + escapeHtml(e.message) + '</div>';
  }
}

function renderDirList() {
  const listEl = document.getElementById('dirList');
  const folders = dirCtx.folders;
  if (!folders.length) {
    listEl.innerHTML = '<div class="empty-state"><span class="es-ico">' + ico('folder') + '</span>此目录没有子文件夹</div>';
    return;
  }
  listEl.innerHTML = folders.map((f) => `<div class="dir-item" onclick="enterDir('${escapeHtml(f.id)}','${escapeHtml(f.name)}')">
    <span class="dir-ico">${ico('folder')}</span><span class="dir-name">${escapeHtml(f.name)}</span><span class="dir-go">›</span>
  </div>`).join('');
}

function enterDir(id, name) {
  dirCtx.stack.push({ id, name });
  renderBreadcrumb();
  browseDir(id);
}

function renderBreadcrumb() {
  const bc = document.getElementById('dirBreadcrumb');
  bc.innerHTML = dirCtx.stack.map((s, i) => {
    const isLast = i === dirCtx.stack.length - 1;
    const label = i === 0 ? '根目录' : escapeHtml(s.name);
    return isLast
      ? `<span class="bc-cur">${label}</span>`
      : `<span class="bc-link" onclick="gotoDir(${i})">${label}</span><span class="bc-sep">/</span>`;
  }).join('');
  const cur = dirCtx.stack[dirCtx.stack.length - 1];
  let target;
  if (dirCtx.provider === 'baidu') target = cur.id === '/' ? '/' : cur.name;
  else target = (cur.id === '0' || cur.id === '') ? '(根目录)' : cur.name;
  document.getElementById('dirHint').textContent = '将转存到: ' + target;
}

function gotoDir(index) {
  dirCtx.stack = dirCtx.stack.slice(0, index + 1);
  renderBreadcrumb();
  browseDir(dirCtx.stack[dirCtx.stack.length - 1].id);
}

function closeDirPicker() {
  document.getElementById('dirModal').classList.remove('show');
}

async function confirmDir() {
  const cur = dirCtx.stack[dirCtx.stack.length - 1];
  const id = cur.id;
  const name = cur.name === '根目录' ? (dirCtx.provider === 'baidu' ? '/' : '根目录') : cur.name;
  const btn = document.getElementById('dirConfirm');
  btn.disabled = true;
  try {
    const r = await fetch('/api/dirs/' + dirCtx.provider, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    const d = await r.json();
    if (!d.ok) { toast('保存失败: ' + (d.error || ''), 'err'); return; }
    closeDirPicker();
    loadAccounts();
  } catch (e) {
    toast('保存失败: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('dirModal').addEventListener('click', (e) => {
  if (e.target.id === 'dirModal') closeDirPicker();
});

// ── 格式化分享文本:乱序原帖 → 标准「标题 + 百度/迅雷/夸克」格式(可编辑,缺盘省略) ──
// 触发已迁移至转存中心 header 的图标按钮（openModal(#fmtMask)），见上方统一弹窗机制
const fmtInput = document.getElementById('fmtInput');
const fmtResult = document.getElementById('fmtResult');
const fmtCopy = document.getElementById('fmtCopy');
const fmtFill = document.getElementById('fmtFill');
const fmtClear = document.getElementById('fmtClear');

// 把任意排版的分享帖整理成标准格式。链接用正则硬抓(顺序/位置无关),标题尽力猜,结果可改。
function formatPost(text) {
  const raw = (text || '').trim();
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);

  // 三家网盘链接(与 parseBatch 同形态,保证「填入转存框」能无缝被下方转存识别)
  const URL_RE = {
    baidu:  /pan\.baidu\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s]*)?/,
    xunlei: /pan\.xunlei\.com\/s\/[A-Za-z0-9_-]+(?:\?[^\s]*)?/,
    quark:  /pan\.quark\.cn\/s\/[A-Za-z0-9_-]+(?:\?[^\s]*)?/,
  };
  const PREFIX = { baidu: '链接: ', xunlei: '链接：', quark: '链接：' };
  const pwdRe = /(?:提取码|密码|提取口令|访问码|口令|pwd)\s*[:：]?\s*([A-Za-z0-9]{4,12})/i;
  const bareCodeRe = /^[A-Za-z0-9]{4,12}$/;

  const jobs = {};
  const linkMeta = [];

  lines.forEach((line, i) => {
    for (const key of ['baidu', 'xunlei', 'quark']) {
      if (jobs[key]) continue;
      const m = line.match(URL_RE[key]);
      if (!m) continue;
      let url = m[0].replace(/[)\]}>。，,；;]+$/, ''); // 去尾随 ) > 。 等废字符
      const full = url.startsWith('http') ? url : 'https://' + url;
      const pm = full.match(/[?&]pwd=([A-Za-z0-9]+)/);
      // 前缀:精确保留源样(含半角/全角冒号与源空格),无「链接」前缀则按各家惯例补
      const preMatch = line.slice(0, m.index).match(/链接\s*[:：]\s*/);
      const prefix = preMatch ? preMatch[0] : PREFIX[key];
      jobs[key] = { link: full, pwd: pm ? pm[1] : '', prefix };
      linkMeta.push({ provider: key, lineNo: i });
      break;
    }
  });

  // 提取码归位:URL 无 pwd 时,从同行/邻近行找「提取码/密码/口令」或纯码行,按最近网盘分配
  const pwdCandidates = [];
  lines.forEach((line, i) => {
    if (/\/\/pan\.(baidu|xunlei|quark)\./.test(line)) return; // 链接行跳过
    const pm = line.match(pwdRe);
    if (pm) pwdCandidates.push({ lineNo: i, pwd: pm[1], keyword: true });
    else if (bareCodeRe.test(line.trim()) && linkMeta.length) pwdCandidates.push({ lineNo: i, pwd: line.trim(), keyword: false });
  });
  pwdCandidates.sort((a, b) => b.keyword - a.keyword); // 显式「提取码:」优先
  for (const cand of pwdCandidates) {
    let best = null, bestDist = Infinity;
    for (const lm of linkMeta) {
      if (jobs[lm.provider].pwd) continue;
      const d = Math.abs(lm.lineNo - cand.lineNo);
      if (d < bestDist) { bestDist = d; best = lm; }
    }
    if (best) jobs[best.provider].pwd = cand.pwd;
  }

  // 标题:取首个非空、非 URL、非小标题行;去《》与行尾【平台标签】
  const HEADER_RE = /^(游戏介绍|内容简介|简介|说明|本帖隐藏|百度\/|迅雷\/|夸克\/|提取码|密码|访问码|口令|分享|资源|下载)[:：]?/;
  let title = '';
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) continue;
    if (HEADER_RE.test(s)) continue;
    if (/^【[^】]*】$/.test(s)) continue;
    title = s.replace(/[《》]/g, '').replace(/【[^】]*】\s*$/, '').trim();
    break;
  }

  // 组装:标题 + 固定顺序三盘链接(缺盘省略);URL 已含 pwd 不再重复
  const out = [];
  if (title) out.push(title);
  for (const key of ['baidu', 'xunlei', 'quark']) {
    const j = jobs[key];
    if (!j) continue;
    const link = j.link.includes('pwd=')
      ? j.link
      : (j.pwd ? j.link + (j.link.includes('?') ? '&' : '?') + 'pwd=' + j.pwd : j.link);
    out.push(j.prefix + link);
  }
  return out.join('\n');
}

function runFormat() {
  fmtResult.value = formatPost(fmtInput.value);
}

fmtInput.addEventListener('input', runFormat);

fmtClear.addEventListener('click', () => {
  fmtInput.value = ''; fmtResult.value = ''; fmtInput.focus();
});

fmtCopy.addEventListener('click', () => {
  if (!fmtResult.value.trim()) return;
  copyText(fmtResult.value, fmtCopy);
});

fmtFill.addEventListener('click', () => {
  const out = fmtResult.value;
  if (!out.trim()) return;
  batchText.value = out;
  refreshUI();
  document.getElementById('batchText').scrollIntoView({ behavior: 'smooth', block: 'center' });
  batchText.focus();
  closeModal(); // 填入后关闭格式化弹窗
});

loadAccounts();
loadTasks();

// 状态胶囊光标光斑（info 态 hover 随动）
if (typeof bindStatusCursor === 'function') bindStatusCursor(document);

// 首屏即时渲染(账户接口已改为立即返回,不再被迅雷 token 冷启动阻塞);
// 2.8s 后再拉一次,等后台探测/迅雷 token 预热完成后刷新卡片上的「联网校验」提示。
setTimeout(loadAccounts, 2800);

// T02：首屏入场编排（零侵入：仅给 .wrap 首屏可见块挂 pop-in + --i，复用内联 macos-motion.css 的 stagger）
(function () {
  function applyEntrance(scope, max) {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    } catch (e) {}
    const root = scope || document;
    const blocks = Array.from(root.children).filter((el) => {
      if (!el || !el.style) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (el.offsetParent === null) return false; // 不在渲染树（如隐藏面板 / #banner）跳过
      return true;
    });
    const n = Math.min(max || 6, blocks.length);
    for (let i = 0; i < n; i++) {
      blocks[i].classList.add("pop-in");
      blocks[i].style.setProperty("--i", i);
    }
  }
  applyEntrance(document.querySelector(".wrap"));
})();
