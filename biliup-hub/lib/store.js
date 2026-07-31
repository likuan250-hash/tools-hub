// lib/store.js —— 配置持久化（data/config.json 读写，内存缓存 + 串行刷盘）
// 数据目录：优先用工具箱注入的 BILIUP_DATA_DIR（指向 userData，升级不丢）；
// 独立运行时回退到安装目录下的 data/。
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.BILIUP_DATA_DIR
  ? path.resolve(process.env.BILIUP_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ── 默认配置（带 PRD/设计已知值；其余 UI 可编辑）──
// 已知常量：tid=17(单机游戏)、seasonId=6918057、sectionId=7630305、copyright=1、
// noReprint=1、line=bda2、uid=236743002、comment 固定文案、AIGC 字段（待用户填真实合规值）。
function defaultConfig() {
  return {
    biliupExePath: 'D:\\biliupR\\biliup.exe',
    ffmpegPath: '', // 空 = 自动探测（biliup 同目录 → PATH → 失败告警）
    cookiesPath: 'D:\\biliupR\\cookies.json',
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
    // AIGC 合规头字段（每次投稿必注入简介末尾）。
    // 真实合规取值需用户提供；此处留空默认，UI 可编辑。Label 固定为 1。
    aigc: {
      label: 1,
      contentProducer: '',
      produceId: '',
      reservedCode1: '',
      contentPropagator: '',
      propagateId: '',
      reservedCode2: '',
    },
  };
}

let cache = null;
let writeQueue = Promise.resolve();
let writeScheduled = false;

function mergeDefaults(obj) {
  const def = defaultConfig();
  const out = Object.assign({}, def, obj || {});
  // 嵌套对象合并（aigc / tags）
  out.aigc = Object.assign({}, def.aigc, (obj && obj.aigc) || {});
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
  if (typeof out.biliupExePath !== 'string') out.biliupExePath = def.biliupExePath;
  if (typeof out.ffmpegPath !== 'string') out.ffmpegPath = def.ffmpegPath;
  if (typeof out.cookiesPath !== 'string' || !out.cookiesPath) out.cookiesPath = def.cookiesPath;
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

module.exports = { loadConfig, getConfig, saveConfig, defaultConfig, mergeDefaults, CONFIG_FILE, DATA_DIR };
