// lib/pendingVideos.js —— 待发布视频名称清单（防忘记）
// 每条记录：{ id, name, hasResource, published, createdAt }
// 「有资源 + 已发布」= 完成，前端据此分到「已完成」标签页。
const fs = require('fs');
const path = require('path');
const store = require('./store');
const logger = require('./logger');

const FILE = path.join(store.DATA_DIR, 'pending_videos.json');

function load(opts = {}) {
  const f = opts.file || FILE;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function save(list, opts = {}) {
  const f = opts.file || FILE;
  fs.writeFileSync(f, JSON.stringify(list, null, 2), 'utf8');
}

function genId() {
  return 'pv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 新增记录；名称空或已存在返回 null。 */
function add(name, opts = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const list = load(opts);
  if (list.some((x) => x.name === trimmed)) return null;
  const item = {
    id: genId(),
    name: trimmed,
    publishDate: typeof opts.publishDate === 'string' ? opts.publishDate.trim() : '',
    hasResource: opts.hasResource === true,
    published: opts.published === true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(item);
  save(list, opts);
  return item;
}

/** 更新记录（hasResource/published 布尔字段）；不存在返回 null。 */
function update(id, patch = {}, opts = {}) {
  const list = load(opts);
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  if (typeof patch.publishDate === 'string') item.publishDate = patch.publishDate.trim();
  if (typeof patch.hasResource === 'boolean') item.hasResource = patch.hasResource;
  if (typeof patch.published === 'boolean') item.published = patch.published;
  item.updatedAt = Date.now();
  save(list, opts);
  return item;
}

function remove(id, opts = {}) {
  const list = load(opts);
  const next = list.filter((x) => x.id !== id);
  if (next.length !== list.length) save(next, opts);
}

/** 清理已完成记录（有资源+已发布），返回移除条数。 */
function clearDone(opts = {}) {
  const list = load(opts);
  const next = list.filter((x) => !(x.hasResource && x.published));
  if (next.length !== list.length) save(next, opts);
  return list.length - next.length;
}

/** 标题归一化：去掉「【游戏NNN】」前缀 + 首尾空白。 */
function normalizeTitle(t) {
  return String(t || '').replace(/^【[^】]*】/, '').trim();
}

/**
 * 投稿成功后自动把同名记录标记为已发布。
 * 匹配：归一化后相等，或一方包含另一方（长度 ≥4 防短名误伤）。
 * @returns {number} 本次标记条数
 */
function markPublishedByTitle(title, opts = {}) {
  const norm = normalizeTitle(title);
  if (!norm) return 0;
  const list = load(opts);
  let changed = 0;
  for (const x of list) {
    if (x.published) continue;
    const n = normalizeTitle(x.name);
    if (!n) continue;
    const hit = n === norm || (n.length >= 4 && norm.includes(n)) || (norm.length >= 4 && n.includes(norm));
    if (hit) {
      x.published = true;
      x.updatedAt = Date.now();
      changed += 1;
      logger.info('[pending-videos] 投稿成功自动标记已发布:', { name: x.name, title });
    }
  }
  if (changed) save(list, opts);
  return changed;
}

module.exports = { load, save, add, update, remove, clearDone, markPublishedByTitle, normalizeTitle, FILE };
