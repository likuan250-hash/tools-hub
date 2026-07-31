// lib/store.js —— 配置持久化（data/config.json 读写，内存缓存 + 串行刷盘）
// 数据目录：优先用工具箱注入的 BILIUP_DATA_DIR（指向 userData，升级不丢）；
// 独立运行时回退到安装目录下的 data/。
const fs = require('fs');
const path = require('path');
const biliupBin = require('./biliupBin');

const DATA_DIR = process.env.BILIUP_DATA_DIR
  ? path.resolve(process.env.BILIUP_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// cookies 默认落点与投稿上传同一份（biliup --cookies 指向它）：
// 打包后 = userData/biliup-hub/data/cookies.json；开发期回退安装目录 data/。
const COOKIES_DIR = DATA_DIR;
const DEFAULT_COOKIES_PATH = path.join(COOKIES_DIR, 'cookies.json');

// ── 默认配置（带 PRD/设计已知值；其余 UI 可编辑）──
// 已知常量：tid=17(单机游戏)、seasonId=6918057、sectionId=7630305、copyright=1、
// noReprint=1、line=bda2、uid=236743002、comment 固定文案。
// 注：biliup.exe 路径不再由 UI 配置（#6），改为按运行环境自动解析。
function defaultConfig() {
  return {
    // biliup.exe 路径：打包内置或开发期回退（lib/biliupBin 解析）。
    biliupExePath: biliupBin.resolveBiliupBin(),
    ffmpegPath: '', // 空 = 自动探测（biliup 同目录 → PATH → 失败告警）
    // cookies 路径：与 BILIUP_DATA_DIR 同目录的 cookies.json（登录/手动放置均可）。
    cookiesPath: DEFAULT_COOKIES_PATH,
    tid: 17,
    seasonId: '6918057',
    sectionId: '7630305',
    copyright: 1,
    noReprint: 1,
    line: 'bda2',
    uid: 236743002,
    tags: [],
    comment: '老规矩！！！三连后关注私信自动回复下载方式',
    // 简介固定 4 行（PRD P0-2）；内容为合理占位，UI 可编辑。
    desc: [
      '本视频为游戏免费学习版下载分享，仅供学习交流使用。',
      '如喜欢请三连支持，关注后私信可自动回复下载方式。',
      '资源来自网络收集整理，版权归原作者所有，请在 24 小时内删除。',
      '如有侵权请联系删除，下载后请支持正版。',
    ].join('\n'),
  };
}

let cache = null;
let writeQueue = Promise.resolve();
let writeScheduled = false;

function mergeDefaults(obj) {
  const def = defaultConfig();
  const out = Object.assign({}, def, obj || {});
  // AIGC 合规头已移除（#3）：清理任何历史残留字段，避免前端/后端误用。
  delete out.aigc;
  if (!Array.isArray(out.tags)) out.tags = def.tags;
  out.tid = Number(out.tid) || def.tid;
  out.copyright = Number(out.copyright) || def.copyright;
  out.noReprint = Number(out.noReprint) || def.noReprint;
  out.uid = Number(out.uid) || def.uid;
  out.seasonId = String(out.seasonId == null ? def.seasonId : out.seasonId);
  out.sectionId = String(out.sectionId == null ? def.sectionId : out.sectionId);
  if (typeof out.line !== 'string' || !out.line) out.line = def.line;
  if (typeof out.comment !== 'string' || !out.comment) out.comment = def.comment;
  if (typeof out.desc !== 'string' || !out.desc) out.desc = def.desc;
  // biliup.exe 路径与 cookies 路径为非用户可配项（#6/#7），始终按运行环境强制解析，
  // 不受历史 config.json 中旧值（如 D:\biliupR\...）影响，避免升级后路径失效。
  out.biliupExePath = biliupBin.resolveBiliupBin();
  out.cookiesPath = DEFAULT_COOKIES_PATH;
  if (typeof out.ffmpegPath !== 'string') out.ffmpegPath = def.ffmpegPath;
  return out;
}

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!cache) {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        cache = mergeDefaults(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
      } else {
        cache = defaultConfig();
        flushWrite();
      }
    } catch (e) {
      cache = defaultConfig();
    }
  }
}

function flushWrite() {
  if (!cache) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try { console.error('[store] write failed:', e.message); } catch (_) {}
  }
}

function scheduleWrite() {
  if (writeScheduled) return;
  writeScheduled = true;
  writeQueue = writeQueue.then(() => {
    writeScheduled = false;
    flushWrite();
  });
}

function loadConfig() {
  ensure();
  return cache;
}

function getConfig() {
  return loadConfig();
}

function saveConfig(c) {
  cache = mergeDefaults(c);
  scheduleWrite();
  return cache;
}

module.exports = {
  loadConfig,
  getConfig,
  saveConfig,
  defaultConfig,
  mergeDefaults,
  CONFIG_FILE,
  DATA_DIR,
  COOKIES_DIR,
  COOKIES_PATH: DEFAULT_COOKIES_PATH,
  getCookiesPath: () => DEFAULT_COOKIES_PATH,
};
