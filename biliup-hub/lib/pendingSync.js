// lib/pendingSync.js —— 待发布清单 GitHub 云端同步（先跑通版）
// 数据真源：私有仓库 pending_videos.json（GitHub Contents API）。
// 策略：启动 pull 合并（按 id + updatedAt 取新）；本地每次变更后 push 全量覆盖。
// token 走现有 AES-256-GCM 加密落盘（data/gh_sync_cred.json），绝不进 git。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const cryptoLib = require('./crypto');
const logger = require('./logger');
const pendingVideos = require('./pendingVideos');

const CRED_FILE = path.join(store.DATA_DIR, 'gh_sync_cred.json');
const GH_API = 'https://api.github.com';

function cfg() {
  return (store.getConfig() && store.getConfig().ghSync) || {};
}

function loadToken() {
  try {
    const blob = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (cryptoLib.isEncrypted(blob)) {
      const obj = cryptoLib.decryptObj(blob);
      if (obj && typeof obj.token === 'string') return obj.token;
    }
  } catch (_) { /* 未配置 */ }
  return '';
}

function saveToken(token) {
  if (!fs.existsSync(store.DATA_DIR)) fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(cryptoLib.encryptObj({ token })), 'utf8');
}

function enabled() {
  const c = cfg();
  return !!(c.enabled && c.repo && loadToken());
}

let lastSync = null; // { ok, ts, msg }
function mark(ok, msg) {
  lastSync = { ok, ts: Date.now(), msg };
}

function apiUrl() {
  const c = cfg();
  return `${GH_API}/repos/${c.repo}/contents/${encodeURIComponent(c.path || 'pending_videos.json')}`;
}

async function gh(method, url, body) {
  const token = loadToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'tools-hub',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${text.slice(0, 120)}`);
  return text ? JSON.parse(text) : null;
}

function ts(x) {
  return Number(x && (x.updatedAt || x.createdAt || 0));
}

/** 合并本地与云端：按 id 对齐，updatedAt 较新者胜（老数据无 updatedAt 时回退 createdAt）。 */
function mergeLists(local, remote) {
  const byId = new Map();
  for (const x of remote) byId.set(x.id, Object.assign({}, x));
  for (const x of local) {
    const ex = byId.get(x.id);
    if (!ex || ts(x) >= ts(ex)) byId.set(x.id, Object.assign({}, x));
  }
  return Array.from(byId.values());
}

async function pullRemote() {
  const data = await gh('GET', apiUrl());
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { list: Array.isArray(content) ? content : [], sha: data.sha };
}

async function pushRemote(list, sha) {
  await gh('PUT', apiUrl(), {
    message: 'sync pending videos',
    content: Buffer.from(JSON.stringify(list, null, 2), 'utf8').toString('base64'),
    sha,
  });
}

/** 启动合并：拉云端 → 与本地按 updatedAt 合并 → 本地落盘 → 合并结果推回云端。 */
async function pullAndMerge() {
  if (!enabled()) return false;
  try {
    const { list: remote, sha } = await pullRemote();
    const local = pendingVideos.load();
    const merged = mergeLists(local, remote);
    pendingVideos.save(merged);
    await pushRemote(merged, sha);
    logger.info(`[gh-sync] pull+merge ok, items=${merged.length}`);
    mark(true, `已同步 ${merged.length} 条`);
    return true;
  } catch (e) {
    logger.warn(`[gh-sync] pull failed: ${e.message}`);
    mark(false, e.message);
    return false;
  }
}

/** 本地变更后推送：先取最新 sha 再覆盖（避免 stale sha 报 409）。 */
async function pushLocal() {
  if (!enabled()) return false;
  try {
    const { sha } = await pullRemote();
    await pushRemote(pendingVideos.load(), sha);
    logger.info('[gh-sync] push ok');
    mark(true, '已同步');
    return true;
  } catch (e) {
    logger.warn(`[gh-sync] push failed: ${e.message}`);
    mark(false, e.message);
    return false;
  }
}

function getStatus() {
  const c = cfg();
  return {
    enabled: !!c.enabled,
    repo: c.repo || '',
    path: c.path || '',
    hasToken: !!loadToken(),
    lastSync,
  };
}

module.exports = { pullAndMerge, pushLocal, loadToken, saveToken, enabled, mergeLists, getStatus, CRED_FILE };
